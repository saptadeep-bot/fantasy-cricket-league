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

// Cross-source team-name matching.  Cricapi returns full names ("Royal
// Challengers Bengaluru"); EntitySport often returns either full names OR
// short-codes ("RCB").  The old equality/substring check failed the short-
// code case entirely, which meant EntitySport-only players got bucketed
// under their short-code team label instead of being merged with the
// cricapi player under the full team name.
//
// Curated alias map covers every IPL team's known variants.  Falls back to
// the generic acronym/substring match so non-IPL fixtures (warm-ups, rare
// tournaments) still work.
const TEAM_ALIASES: Record<string, string[]> = {
  "royal challengers bengaluru": ["rcb", "royal challengers bangalore", "bengaluru", "bangalore"],
  "royal challengers bangalore": ["rcb", "royal challengers bengaluru", "bengaluru", "bangalore"],
  "chennai super kings": ["csk", "chennai"],
  "mumbai indians": ["mi", "mumbai"],
  "kolkata knight riders": ["kkr", "kolkata"],
  "sunrisers hyderabad": ["srh", "hyderabad"],
  "delhi capitals": ["dc", "delhi"],
  "punjab kings": ["pbks", "punjab", "kings xi punjab", "kxip"],
  "rajasthan royals": ["rr", "rajasthan"],
  "lucknow super giants": ["lsg", "lucknow"],
  "gujarat titans": ["gt", "gujarat"],
}

function acronymOf(name: string): string {
  const parts = normaliseName(name).split(" ").filter(Boolean)
  if (parts.length < 2) return ""
  return parts.map(p => p[0]).join("")
}

function sameTeam(a: string, b: string): boolean {
  const na = normaliseName(a), nb = normaliseName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Curated alias lookup — handles "LSG" ↔ "Lucknow Super Giants" etc.
  const aliasA = TEAM_ALIASES[na] ?? []
  if (aliasA.includes(nb)) return true
  const aliasB = TEAM_ALIASES[nb] ?? []
  if (aliasB.includes(na)) return true
  // Cross-match if they share any alias (e.g. both aliases of the same team)
  if (aliasA.some(x => aliasB.includes(x))) return true
  // Generic acronym match: "lsg" vs "lucknow super giants"
  if (acronymOf(na) === nb || acronymOf(nb) === na) return true
  // Fallback: substring containment (original behaviour)
  return na.includes(nb) || nb.includes(na)
}

// Canonicalise a team name returned by cricapi/EntitySport against the
// match's actual team1/team2.  Returns the canonical DB string if there's
// a match, or null if the API gave us a rogue team (e.g. cricapi's pre-
// toss squad endpoint occasionally returns the wrong team — we saw it
// return Lahore Qalandars for an MI vs SRH fixture days before the toss).
//
// Returning null lets the caller filter out players belonging to a team
// that has nothing to do with this match, instead of inserting them and
// letting users draft fictional squads.
function canonicalTeam(apiTeamName: string, t1: string, t2: string): string | null {
  if (!apiTeamName) return null
  if (sameTeam(apiTeamName, t1)) return t1
  if (sameTeam(apiTeamName, t2)) return t2
  return null
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

  // Defensive read: SELECT * so that a missing `entitysport_match_id` column
  // (migration not yet run) doesn't 400 the whole request.  Degrades cleanly:
  // `cachedEsMatchId` is just undefined and the fetcher re-runs the listing
  // aggregation.
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matchRow = match as Record<string, any>
  const cricketdataMatchId = (matchRow.cricketdata_match_id as string | undefined) ?? ""
  const matchTeam1 = (matchRow.team1 as string | undefined) ?? ""
  const matchTeam2 = (matchRow.team2 as string | undefined) ?? ""
  const cachedEsMatchId = (matchRow.entitysport_match_id as string | null | undefined) ?? null

  try {
    // Parallel fetch — EntitySport failures (quota / outage) must NOT block
    // cricapi.  Each returns `{ players: null, reason }` on failure.  Pass
    // the cached EntitySport match_id so we skip the listing aggregation when
    // we've already resolved it on a prior fetch.
    const [cricapiResult, esResult] = await Promise.all([
      fetchCricapiSquad(cricketdataMatchId),
      fetchEntitySportSquadDetailed(matchTeam1, matchTeam2, cachedEsMatchId),
    ])

    // Persist EntitySport match_id to cut quota on future fetches.  Wrapped
    // in try/catch: if the column doesn't exist yet, swallow the error so
    // the squad fetch itself still succeeds.
    if (esResult.resolvedEsMatchId && esResult.resolvedEsMatchId !== cachedEsMatchId) {
      try {
        await supabaseAdmin
          .from("matches")
          .update({ entitysport_match_id: esResult.resolvedEsMatchId })
          .eq("id", id)
      } catch {
        // Ignore — migration may not have run yet.  Not fatal; we'll retry
        // on the next fetch.
      }
    }

    const cricapiPlayersRaw = cricapiResult.players ?? []
    const esPlayersRaw = esResult.players ?? []

    if (cricapiPlayersRaw.length === 0 && esPlayersRaw.length === 0) {
      return NextResponse.json({
        error: `Both squad sources returned empty. cricapi: ${cricapiResult.reason} | entitysport: ${esResult.reason}`,
      }, { status: 500 })
    }

    // Team-name validation — reject any player whose team doesn't match
    // either of this match's two configured teams.  cricapi's pre-toss
    // /match_squad endpoint occasionally returns wrong-team data (we saw
    // it return Lahore Qalandars instead of SRH for an MI vs SRH fixture).
    // Without this filter, fictional squads pollute the DB and users draft
    // players from teams that aren't even playing.
    //
    // We also re-label the team to the canonical DB string (so cricapi's
    // "Mumbai Indians" and ES's "Mumbai Indians" both store as the exact
    // value of match.team1, no drift).
    const cricapiPlayers: CricapiSquadPlayer[] = []
    const cricapiRejectedTeams = new Set<string>()
    for (const p of cricapiPlayersRaw) {
      const canon = canonicalTeam(p.team, matchTeam1, matchTeam2)
      if (canon) {
        cricapiPlayers.push({ ...p, team: canon })
      } else {
        cricapiRejectedTeams.add(p.team)
      }
    }
    const esPlayers: EntitySportSquadPlayer[] = []
    const esRejectedTeams = new Set<string>()
    for (const p of esPlayersRaw) {
      const canon = canonicalTeam(p.team, matchTeam1, matchTeam2)
      if (canon) {
        esPlayers.push({ ...p, team: canon })
      } else {
        esRejectedTeams.add(p.team)
      }
    }

    if (cricapiPlayers.length === 0 && esPlayers.length === 0) {
      // Every team that came back was rogue — refuse to insert anything.
      const rejectedAll = [...cricapiRejectedTeams, ...esRejectedTeams].filter(Boolean)
      return NextResponse.json({
        error: `No squad data for ${matchTeam1} or ${matchTeam2}.${rejectedAll.length > 0 ? ` Both APIs returned wrong teams: ${rejectedAll.join(", ")}.` : ""} This usually means cricapi has stale/wrong data for this fixture pre-toss. Try again closer to match time, or use API Match ID override if cricapi has a different ID for this fixture.`,
        diagnostic: {
          cricapi: { reason: cricapiResult.reason, rejectedTeams: [...cricapiRejectedTeams] },
          entitysport: { reason: esResult.reason, rejectedTeams: [...esRejectedTeams] },
        },
      }, { status: 422 })
    }

    const { merged, cricapiOnly, esOnly, both } = mergeSquads(cricapiPlayers, esPlayers)

    // Read existing players so we can preserve their is_playing/is_substitute/
    // fantasy_points flags and detect "in DB but not in either source" rows.
    // SELECT * so a missing `is_substitute` column (migration not run yet)
    // doesn't 400 this request — we fall back to treating all existing as
    // non-subs, which is safe.
    const { data: existingRows } = await supabaseAdmin
      .from("match_players")
      .select("*")
      .eq("match_id", id)

    const existingById = new Map<string, NonNullable<typeof existingRows>[number]>()
    for (const r of existingRows || []) existingById.set(r.cricketdata_player_id, r)

    // Cleanup: identify existing rows whose team name doesn't match either
    // of the configured match teams.  These are stale rogue inserts from a
    // previous bad fetch (e.g. the Lahore Qalandars / SRH bug).  We delete
    // them — they can't possibly be legitimate players for this match, so
    // the "non-destructive preserve" policy doesn't apply.  Manual-add and
    // live-auto-add players DO have valid team names, so they're untouched.
    const rogueExisting = (existingRows || []).filter(r =>
      !canonicalTeam(r.team ?? "", matchTeam1, matchTeam2),
    )
    let rogueCleaned = 0
    if (rogueExisting.length > 0) {
      const { error: cleanupErr } = await supabaseAdmin
        .from("match_players")
        .delete()
        .in("id", rogueExisting.map(r => r.id))
      if (!cleanupErr) {
        rogueCleaned = rogueExisting.length
        // Also remove them from existingById so they don't get treated as
        // "already exists" during the upsert split below.
        for (const r of rogueExisting) existingById.delete(r.cricketdata_player_id)
      }
    }

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

    // Insert new rows.  If the `is_substitute` column doesn't exist yet
    // (migration not run) the insert will fail with a PGRST/PGRST204 column-
    // not-found error.  Retry once with `is_substitute` stripped so the
    // squad fetch still succeeds in that scenario — we'd rather lose the
    // sub-flag for now than break the whole match setup flow.
    if (toInsert.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from("match_players")
        .insert(toInsert)
      if (insertError) {
        const msg = insertError.message || ""
        const looksLikeMissingColumn =
          /is_substitute/i.test(msg) && /column|does not exist|schema cache/i.test(msg)
        if (looksLikeMissingColumn) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const stripped = toInsert.map(({ is_substitute, ...rest }) => rest)
          const { error: retryErr } = await supabaseAdmin.from("match_players").insert(stripped)
          if (retryErr) {
            return NextResponse.json({ error: "insert (retry): " + retryErr.message }, { status: 500 })
          }
        } else {
          return NextResponse.json({ error: "insert: " + msg }, { status: 500 })
        }
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
    // SELECT * to stay resilient against schema drift (is_substitute column
    // may not exist yet).  The client discards anything it doesn't know
    // about, so extra fields are harmless.
    const { data: finalPlayers } = await supabaseAdmin
      .from("match_players")
      .select("*")
      .eq("match_id", id)
      .order("team")
      .order("role")

    // Coverage check: did we actually get players for BOTH configured
    // teams?  If only one is represented in the merged set, the admin
    // needs to know — they should retry closer to match time rather than
    // lock in with half a squad.
    const teamsCovered = new Set(merged.map(m => m.team))
    const missingTeams = [matchTeam1, matchTeam2].filter(t => t && !teamsCovered.has(t))
    const allRejectedTeams = [
      ...cricapiRejectedTeams,
      ...esRejectedTeams,
    ].filter(Boolean)

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
        rogueCleaned,
      },
      // `warning` is non-fatal — squad partially fetched.  UI surfaces this
      // so admin can decide whether to retry later or accept a one-team
      // squad and add the other side manually.
      warning: missingTeams.length > 0
        ? `Squad fetched for ${[...teamsCovered].join(", ") || "(none)"} but missing for ${missingTeams.join(", ")}.${allRejectedTeams.length > 0 ? ` API returned wrong team(s): ${allRejectedTeams.join(", ")}.` : ""} Pre-toss data is often unreliable — retry closer to match time.`
        : (allRejectedTeams.length > 0
          ? `Filtered out wrong-team data: ${allRejectedTeams.join(", ")}. Both correct teams' squads were fetched successfully.`
          : null),
      rejected: {
        cricapi: [...cricapiRejectedTeams],
        entitysport: [...esRejectedTeams],
      },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
