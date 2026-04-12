import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"
import { NextRequest, NextResponse } from "next/server"

// Give Vercel up to 60 seconds for API calls (instead of default 10s)
export const maxDuration = 60

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

async function computeAndSave(matchId: string, scorecard: unknown[]) {
  const pointsMap = calculateFantasyPoints(scorecard)
  if (pointsMap.size === 0) return { updated: 0, total: 0, remapped: 0 }

  // Load current match_players from DB
  const { data: dbPlayers } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name")
    .eq("match_id", matchId)

  const nameToDbId = new Map<string, string>()
  const dbIds = new Set<string>()
  for (const p of (dbPlayers || [])) {
    // Normalize name: lowercase, collapse spaces, strip dots
    const key = p.name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()
    nameToDbId.set(key, p.cricketdata_player_id)
    dbIds.add(p.cricketdata_player_id)
  }

  const now = new Date().toISOString()
  const directUpdates: { match_id: string; cricketdata_player_id: string; fantasy_points: number; last_updated: string }[] = []
  const idRemaps: Array<{ oldId: string; newId: string; fantasyPoints: number }> = []
  const nameMissed: string[] = []

  for (const [playerId, pts] of pointsMap.entries()) {
    const fantasyPoints = Math.round(pts.total * 10) / 10
    const normalizedName = pts.name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()

    if (dbIds.has(playerId)) {
      // Direct ID match — batch update
      directUpdates.push({ match_id: matchId, cricketdata_player_id: playerId, fantasy_points: fantasyPoints, last_updated: now })
    } else {
      // Try name-based fallback
      const dbId = nameToDbId.get(normalizedName)
      if (dbId) {
        idRemaps.push({ oldId: dbId, newId: playerId, fantasyPoints })
      } else {
        nameMissed.push(pts.name)
      }
    }
  }

  // --- Batch direct updates (single DB round-trip) ---
  let updated = 0
  if (directUpdates.length > 0) {
    // Supabase upsert with on-conflict update
    const { error } = await supabaseAdmin
      .from("match_players")
      .upsert(directUpdates, { onConflict: "match_id,cricketdata_player_id" })
    if (!error) updated += directUpdates.length
  }

  // --- Name-based remaps (fix IDs + points in one update per remap) ---
  for (const remap of idRemaps) {
    const { error } = await supabaseAdmin
      .from("match_players")
      .update({
        cricketdata_player_id: remap.newId,
        fantasy_points: remap.fantasyPoints,
        last_updated: now,
      })
      .eq("match_id", matchId)
      .eq("cricketdata_player_id", remap.oldId)
    if (!error) updated++
  }

  // --- Fix team player_ids / captain / vc to use corrected IDs ---
  if (idRemaps.length > 0) {
    const { data: teamsData } = await supabaseAdmin
      .from("teams")
      .select("id, player_ids, captain_id, vice_captain_id")
      .eq("match_id", matchId)

    for (const team of (teamsData || [])) {
      let changed = false
      let playerIds: string[] = team.player_ids || []
      let captainId: string = team.captain_id
      let vcId: string = team.vice_captain_id

      for (const { oldId, newId } of idRemaps) {
        if (playerIds.includes(oldId)) {
          playerIds = playerIds.map(pid => pid === oldId ? newId : pid)
          changed = true
        }
        if (captainId === oldId) { captainId = newId; changed = true }
        if (vcId === oldId) { vcId = newId; changed = true }
      }

      if (changed) {
        await supabaseAdmin
          .from("teams")
          .update({ player_ids: playerIds, captain_id: captainId, vice_captain_id: vcId })
          .eq("id", team.id)
      }
    }
  }

  return { updated, total: pointsMap.size, remapped: idRemaps.length, missed: nameMissed }
}

async function fetchAndSaveScores(matchId: string, cricketdataMatchId: string) {
  let resolvedId = cricketdataMatchId

  const res = await fetch(
    `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${resolvedId}`,
    { cache: "no-store" }
  )
  const data = await res.json()

  if (data.status !== "success") {
    const reason = (data.reason || data.message || "").toLowerCase()
    if (reason.includes("not found") || reason.includes("invalid")) {
      // Match ID may have changed when match went live — try auto-correct
      const { data: matchRow } = await supabaseAdmin
        .from("matches")
        .select("team1, team2")
        .eq("id", matchId)
        .single()

      if (matchRow) {
        const liveRes = await fetch(
          `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=0`,
          { cache: "no-store" }
        )
        const liveData = await liveRes.json()
        const liveMatches: { id: string; name: string; teams: string[] }[] = liveData.data || []

        const t1Last = matchRow.team1.split(" ").pop()!.toLowerCase()
        const t2Last = matchRow.team2.split(" ").pop()!.toLowerCase()
        const found = liveMatches.find(m =>
          m.teams?.some((t: string) => t.toLowerCase().includes(t1Last)) &&
          m.teams?.some((t: string) => t.toLowerCase().includes(t2Last))
        )

        if (found && found.id !== cricketdataMatchId) {
          await supabaseAdmin
            .from("matches")
            .update({ cricketdata_match_id: found.id })
            .eq("id", matchId)
          resolvedId = found.id

          const retryRes = await fetch(
            `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${resolvedId}`,
            { cache: "no-store" }
          )
          const retryData = await retryRes.json()
          if (retryData.status === "success") {
            const scorecard = retryData.data?.scorecard || []
            if (scorecard.length === 0) throw new Error("Scorecard empty — match may just be starting.")
            return await computeAndSave(matchId, scorecard)
          }
          throw new Error("Scorecard not available after ID correction. Match may still be starting.")
        }
      }
      throw new Error("Scorecard not available yet. The match may just be starting — try again in a minute.")
    }
    throw new Error(`Cricket API error: ${data.reason || data.message || "Unknown error"}`)
  }

  const scorecard = data.data?.scorecard || []
  if (scorecard.length === 0) {
    throw new Error("Scorecard empty. Match may not have started yet — try again shortly.")
  }

  return await computeAndSave(matchId, scorecard)
}

// ─── READ players from DB (shared helper) ───────────────────────────────────
async function readPlayersFromDb(matchId: string) {
  const { data: players } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name, team, role, fantasy_points, last_updated")
    .eq("match_id", matchId)
    .order("fantasy_points", { ascending: false })
  return players || []
}

// ─── Admin: force-fetch from API ────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("cricketdata_match_id, status")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })

  try {
    const result = await fetchAndSaveScores(id, match.cricketdata_match_id)
    const players = await readPlayersFromDb(id)
    return NextResponse.json({ success: true, players, ...result })
  } catch (err) {
    return NextResponse.json({ error: String(err).replace(/Error:\s*/g, "") }, { status: 400 })
  }
}

// ─── Public GET ─────────────────────────────────────────────────────────────
// ?refresh=1  → participant pressed "Refresh": always reads DB (fast, no API call)
// no params   → auto-poll: fetches from API if data is stale, then returns DB data
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const isParticipantRefresh = url.searchParams.get("refresh") === "1"
  // Legacy ?force=true also treated as participant refresh (DB read only)
  const isForce = url.searchParams.get("force") === "true"

  if (isParticipantRefresh || isForce) {
    // Just read the latest from DB — always fast, always works
    const players = await readPlayersFromDb(id)
    return NextResponse.json({ players })
  }

  // Auto-poll path: fetch from API if data is stale (>90 seconds)
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("status, cricketdata_match_id")
    .eq("id", id)
    .single()

  if (match?.status === "live" && match?.cricketdata_match_id) {
    const { data: lastPlayer } = await supabaseAdmin
      .from("match_players")
      .select("last_updated")
      .eq("match_id", id)
      .not("last_updated", "is", null)
      .order("last_updated", { ascending: false })
      .limit(1)
      .single()

    const lastUpdated = lastPlayer?.last_updated ? new Date(lastPlayer.last_updated) : null
    const ninetySecondsAgo = new Date(Date.now() - 90 * 1000)
    const isStale = !lastUpdated || lastUpdated < ninetySecondsAgo

    if (isStale) {
      try {
        await fetchAndSaveScores(id, match.cricketdata_match_id)
      } catch {
        // Silently fail — return whatever is in the DB
      }
    }
  }

  const players = await readPlayersFromDb(id)
  return NextResponse.json({ players })
}
