// Non-destructive squad fetch with dual source (cricapi + EntitySport).
//
// Why this exists in its current shape — 2026-04-23:
// The original implementation did `DELETE ... WHERE match_id` then INSERT, which
// had two bad failure modes:
//   1. Cricapi's `/v1/match_squad` endpoint doesn't include named impact
//      substitutes (e.g. G Linde vs LSG on 2026-04-22).  Re-fetching after toss
//      silently dropped Linde from the squad even though he was announced as a
//      sub, breaking any teams that drafted him.
//   2. When live scoring auto-inserts a player (is_substitute=true) via
//      `computeAndSave`, a subsequent re-fetch would DELETE that auto-added
//      row, re-insert only the cricapi-known players, and leave the teams
//      referring to an orphan ID.
//
// Fixes here:
//   - Fetch cricapi + EntitySport in parallel; merge by case-insensitive name
//     within the same team.
//   - UPSERT by (match_id, cricketdata_player_id) — updates name/role/team only.
//     Never resets is_playing, is_substitute, or fantasy_points for existing
//     rows.
//   - For EntitySport-only players (impact subs cricapi missed), mint an
//     `es_<player_id>` ID and insert fresh.  Non-clashing with cricapi's
//     numeric IDs.
//   - For players already in DB that neither source returned this time:
//     KEEP them.  They may have been manually added by the admin, or
//     auto-added during live scoring.  Removing them would break teams.

import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchEntitySportSquadDetailed, type EntitySportSquadPlayer } from "@/lib/scorecard-sources"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

type Role = "BAT" | "BOWL" | "ALL" | "WK"

function mapRole(role: string): Role {
  const r = role.toLowerCase()
  if (r.includes("wk") || r.includes("wicket")) return "WK"
  if (r.includes("bowling allrounder") || r.includes("all-rounder") || r.includes("allrounder")) return "ALL"
  if (r.includes("batting allrounder")) return "ALL"
  if (r.includes("bowler") || r.includes("bowling")) return "BOWL"
  if (r.includes("batsman") || r.includes("batter") || r.includes("batting")) return "BAT"
  return "BAT"
}

// Normalise a player name for cross-source matching.  EntitySport often uses
// full names ("Abhishek Sharma"), cricapi uses shortened ("A Sharma").  We
// normalise to lowercase + strip punctuation + collapse whitespace, and then
// also compute a compact "initial + last name" form.
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim()
}
function compactKey(name: string): string {
  const n = normaliseName(name)
  const parts = n.split(" ").filter(Boolean)
  if (parts.length < 2) return n
  return parts[0][0] + " " + parts[parts.length - 1]
}

interface CricapiSquadPlayer {
  cricketdata_player_id: string
  name: string
  team: string
  role: Role
}

async function fetchCricapiSquad(cricketdataMatchId: string): Promise<{ players: CricapiSquadPlayer[] | null; reason: string }> {
  if (!cricketdataMatchId) return { players: null, reason: "no_match_id" }
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_squad?apikey=${CRICKETDATA_API_KEY}&id=${cricketdataMatchId}`,
      { cache: "no-store" }
    )
    if (!res.ok) return { players: null, reason: `http_${res.status}` }
    const data = await res.json()
    if (data.status !== "success") return { players: null, reason: `api_${data.status || "err"}` }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teams: any[] = data.data || []
    const players: CricapiSquadPlayer[] = []
    for (const team of teams) {
      const teamName = team.teamName || team.teamInfo?.name || team.team || "Unknown"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const squad: any[] = team.players || team.squad || []
      for (const player of squad) {
        if (!player?.id || !player?.name) continue
        players.push({
          cricketdata_player_id: String(player.id),
          name: String(player.name),
          team: teamName,
          role: mapRole(player.role || player.playerRole || ""),
        })
      }
    }
    return { players, reason: `ok_${players.length}` }
  } catch (e) {
    return { players: null, reason: `error:${String(e).slice(0, 60)}` }
  }
}

// Merge cricapi + EntitySport into one deduped list.
// Rules:
//   - Cricapi wins on ID (its IDs match the rest of our pipeline cleanly).
//   - EntitySport fills in players cricapi missed.
//   - Match across sources by compactKey (so "A Sharma" <-> "Abhishek Sharma"
//     within the same team both collapse to the same person).
//   - Team-name matching is best-effort: if the EntitySport team name starts
//     with / contains / is contained by the cricapi team name, treat as same
//     team for keying purposes.
interface MergedPlayer {
  cricketdata_player_id: string   // may be an `es_<id>` for EntitySport-only
  name: string
  team: string
  role: Role
  source: "cricapi" | "entitysport" | "both"
  is_substitute_hint: boolean  // from EntitySport's `substitute:"true"`
  is_playing_hint: boolean     // from EntitySport's `playing11:"true"`
}

function sameTeam(a: string, b: string): boolean {
  const na = normaliseName(a), nb = normaliseName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  return na.includes(nb) || nb.includes(na)
}

function mergeSquads(
  cricapiPlayers: CricapiSquadPlayer[],
  esPlayers: EntitySportSquadPlayer[],
): { merged: MergedPlayer[]; cricapiOnly: number; esOnly: number; both: number } {
  const merged: MergedPlayer[] = []
  const usedEs = new Set<number>()

  // First pass: every cricapi player goes in.  Try to find an EntitySport
  // match for hint fields.
  for (const cp of cricapiPlayers) {
    const key = compactKey(cp.name)
    const esIdx = esPlayers.findIndex((ep, i) => {
      if (usedEs.has(i)) return false
      if (!sameTeam(cp.team, ep.team)) return false
      const epKey = compactKey(ep.name)
      return epKey === key || normaliseName(ep.name) === normaliseName(cp.name)
    })
    if (esIdx >= 0) {
      const ep = esPlayers[esIdx]
      usedEs.add(esIdx)
      merged.push({
        cricketdata_player_id: cp.cricketdata_player_id,
        name: cp.name,
        team: cp.team,
        role: cp.role,
        source: "both",
        is_substitute_hint: ep.es_substitute,
        is_playing_hint: ep.es_playing11,
      })
    } else {
      merged.push({
        cricketdata_player_id: cp.cricketdata_player_id,
        name: cp.name,
        team: cp.team,
        role: cp.role,
        source: "cricapi",
        is_substitute_hint: false,
        is_playing_hint: false,
      })
    }
  }

  // Second pass: EntitySport-only players (the Linde case).
  let esOnly = 0
  for (let i = 0; i < esPlayers.length; i++) {
    if (usedEs.has(i)) continue
    const ep = esPlayers[i]
    // Map EntitySport team name → cricapi team name if possible, otherwise
    // use EntitySport's as-is.  Keeps team labels consistent in the UI.
    const cricapiTeamMatch = cricapiPlayers.find(cp => sameTeam(cp.team, ep.team))
    const resolvedTeam = cricapiTeamMatch?.team ?? ep.team
    merged.push({
      cricketdata_player_id: `es_${ep.es_player_id}`,
      name: ep.name,
      team: resolvedTeam,
      role: ep.role,
      source: "entitysport",
      is_substitute_hint: ep.es_substitute,
      is_playing_hint: ep.es_playing11,
    })
    esOnly++
  }

  return {
    merged,
    cricapiOnly: merged.filter(m => m.source === "cricapi").length,
    esOnly,
    both: merged.filter(m => m.source === "both").length,
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("cricketdata_match_id, team1, team2")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })

  try {
    // Parallel fetch — EntitySport failures (quota / outage) must NOT block
    // cricapi.  Each returns `{ players: null, reason }` on failure.
    const [cricapiResult, esResult] = await Promise.all([
      fetchCricapiSquad(match.cricketdata_match_id),
      fetchEntitySportSquadDetailed(match.team1 ?? "", match.team2 ?? ""),
    ])

    const cricapiPlayers = cricapiResult.players ?? []
    const esPlayers = esResult.players ?? []

    if (cricapiPlayers.length === 0 && esPlayers.length === 0) {
      return NextResponse.json({
        error: `Both squad sources returned empty. cricapi: ${cricapiResult.reason} | entitysport: ${esResult.reason}`,
      }, { status: 500 })
    }

    const { merged, cricapiOnly, esOnly, both } = mergeSquads(cricapiPlayers, esPlayers)

    // Read existing players so we can preserve their is_playing/is_substitute/
    // fantasy_points flags and detect "in DB but not in either source" rows.
    const { data: existingRows } = await supabaseAdmin
      .from("match_players")
      .select("id, cricketdata_player_id, name, team, role, is_playing, is_substitute, fantasy_points")
      .eq("match_id", id)

    const existingById = new Map<string, NonNullable<typeof existingRows>[number]>()
    for (const r of existingRows || []) existingById.set(r.cricketdata_player_id, r)

    // For every merged player: UPSERT by (match_id, cricketdata_player_id).
    // Supabase's upsert with onConflict does exactly this.  We split the rows
    // into "update" (already exists, change only metadata) and "insert" (new).
    const now = new Date().toISOString()
    const toInsert: Array<Record<string, unknown>> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toUpdate: Array<{ id: string; patch: Record<string, any> }> = []

    for (const p of merged) {
      const existing = existingById.get(p.cricketdata_player_id)
      if (existing) {
        // Update metadata only.  Never touch is_playing / is_substitute /
        // fantasy_points — those are set by the lock endpoint and live scoring.
        toUpdate.push({
          id: existing.id,
          patch: {
            name: p.name,
            team: p.team,
            role: p.role,
            last_updated: now,
          },
        })
      } else {
        toInsert.push({
          match_id: id,
          cricketdata_player_id: p.cricketdata_player_id,
          name: p.name,
          team: p.team,
          role: p.role,
          is_playing: false,
          is_substitute: false,
          fantasy_points: 0,
          last_updated: now,
        })
      }
    }

    // Insert new rows
    if (toInsert.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from("match_players")
        .insert(toInsert)
      if (insertError) {
        return NextResponse.json({ error: "insert: " + insertError.message }, { status: 500 })
      }
    }

    // Update metadata on existing rows.  Doing this serially is fine — at
    // most ~30 players per match, and most will be no-op updates that
    // Supabase short-circuits.
    for (const u of toUpdate) {
      await supabaseAdmin.from("match_players").update(u.patch).eq("id", u.id)
    }

    // Compute "preserved" = in DB but not in either source this time.  We do
    // NOT delete these — they're likely manually-added or live-auto-added.
    const mergedIds = new Set(merged.map(m => m.cricketdata_player_id))
    const preserved = (existingRows || []).filter(r => !mergedIds.has(r.cricketdata_player_id))

    // Re-read the full current squad so the client can refresh its state.
    const { data: finalPlayers } = await supabaseAdmin
      .from("match_players")
      .select("id, cricketdata_player_id, name, team, role, is_playing, is_substitute, fantasy_points")
      .eq("match_id", id)
      .order("team")
      .order("role")

    return NextResponse.json({
      success: true,
      players: finalPlayers || [],
      sources: {
        cricapi: cricapiResult.reason,
        entitysport: esResult.reason,
      },
      counts: {
        total: finalPlayers?.length ?? 0,
        cricapiOnly,
        entitysportOnly: esOnly,
        bothSources: both,
        inserted: toInsert.length,
        updated: toUpdate.length,
        preserved: preserved.length,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
