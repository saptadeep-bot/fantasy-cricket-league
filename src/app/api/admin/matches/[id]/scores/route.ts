import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

async function computeAndSave(matchId: string, scorecard: unknown[]) {
  const pointsMap = calculateFantasyPoints(scorecard)

  // Build name → row map from DB for fallback matching
  const { data: dbPlayers } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name")
    .eq("match_id", matchId)

  const nameToDbId = new Map<string, string>()
  const dbIds = new Set<string>()
  for (const p of (dbPlayers || [])) {
    nameToDbId.set(p.name.toLowerCase().trim(), p.cricketdata_player_id)
    dbIds.add(p.cricketdata_player_id)
  }

  let updated = 0
  const idRemaps: Array<{ oldId: string; newId: string }> = []

  for (const [playerId, pts] of pointsMap.entries()) {
    const fantasyPoints = Math.round(pts.total * 10) / 10
    const now = new Date().toISOString()

    if (dbIds.has(playerId)) {
      // ID matches directly — normal update
      const { error } = await supabaseAdmin
        .from("match_players")
        .update({ fantasy_points: fantasyPoints, last_updated: now })
        .eq("match_id", matchId)
        .eq("cricketdata_player_id", playerId)
      if (!error) updated++
    } else {
      // ID doesn't match — try name-based fallback
      const dbId = nameToDbId.get(pts.name.toLowerCase().trim())
      if (dbId) {
        // Correct the stored ID first so future fetches work, then update points
        await supabaseAdmin
          .from("match_players")
          .update({ cricketdata_player_id: playerId, fantasy_points: fantasyPoints, last_updated: now })
          .eq("match_id", matchId)
          .eq("cricketdata_player_id", dbId)
        idRemaps.push({ oldId: dbId, newId: playerId })
        updated++
      }
    }
  }

  // Fix team player_ids to use corrected IDs (so captain/vc multipliers still apply)
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

  return { updated, total: pointsMap.size, remapped: idRemaps.length }
}

async function fetchAndSaveScores(matchId: string, cricketdataMatchId: string) {
  let resolvedId = cricketdataMatchId

  const res = await fetch(
    `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${resolvedId}`,
    { cache: "no-store" }
  )
  const data = await res.json()

  // If scorecard not found, the API may have assigned a new ID when match went live.
  // Auto-correct by searching currentMatches for the right ID.
  if (data.status !== "success") {
    const reason = data.reason || data.message || ""
    if (reason.toLowerCase().includes("not found")) {
      // Fetch our match's team names to identify it
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

        // Find match by both team names
        const found = liveMatches.find(m =>
          m.teams?.some((t: string) => t.toLowerCase().includes(matchRow.team1.split(" ").pop()!.toLowerCase())) &&
          m.teams?.some((t: string) => t.toLowerCase().includes(matchRow.team2.split(" ").pop()!.toLowerCase()))
        )

        if (found && found.id !== cricketdataMatchId) {
          // Save the corrected ID to DB so future fetches work
          await supabaseAdmin
            .from("matches")
            .update({ cricketdata_match_id: found.id })
            .eq("id", matchId)
          resolvedId = found.id

          // Retry scorecard with corrected ID
          const retryRes = await fetch(
            `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${resolvedId}`,
            { cache: "no-store" }
          )
          const retryData = await retryRes.json()
          if (retryData.status === "success") {
            const scorecard = retryData.data?.scorecard || []
            if (scorecard.length === 0) throw new Error("Scorecard is empty — match may not have started yet.")
            return await computeAndSave(matchId, scorecard)
          }
        }
      }
      throw new Error("Scorecard not available yet. The match may just be starting — try again in a minute.")
    }
    throw new Error(`Cricket API error: ${reason}`)
  }

  const scorecard = data.data?.scorecard || []
  if (scorecard.length === 0) {
    throw new Error("Scorecard is empty. Match may not have started yet — try again shortly.")
  }

  return await computeAndSave(matchId, scorecard)
}

// Admin: manual fetch trigger
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
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 })
  }
}

// Public GET: auto-refreshes scores if match is live and data is stale (>9 min)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("status, cricketdata_match_id")
    .eq("id", id)
    .single()

  const url = new URL(req.url)
  const force = url.searchParams.get("force") === "true"

  if (match?.cricketdata_match_id) {
    let shouldFetch = false

    if (force) {
      // Manual refresh: always fetch regardless of match status
      shouldFetch = true
    } else if (match.status === "live") {
      // Auto-poll: only fetch if data is stale (>9 min)
      const { data: lastPlayer } = await supabaseAdmin
        .from("match_players")
        .select("last_updated")
        .eq("match_id", id)
        .order("last_updated", { ascending: false })
        .limit(1)
        .single()

      const lastUpdated = lastPlayer?.last_updated ? new Date(lastPlayer.last_updated) : null
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000)
      shouldFetch = !lastUpdated || lastUpdated < threeMinutesAgo
    }

    if (shouldFetch) {
      if (force) {
        // For manual refresh — surface errors so the client knows what went wrong
        try {
          const result = await fetchAndSaveScores(id, match.cricketdata_match_id)
          const { data: players } = await supabaseAdmin
            .from("match_players")
            .select("cricketdata_player_id, name, team, role, fantasy_points, last_updated")
            .eq("match_id", id)
            .order("fantasy_points", { ascending: false })
          return NextResponse.json({ players: players || [], ...result })
        } catch (err) {
          return NextResponse.json({ error: String(err) }, { status: 400 })
        }
      } else {
        // Auto-poll — silently fail, return DB data
        try {
          await fetchAndSaveScores(id, match.cricketdata_match_id)
        } catch {
          // Silently fail
        }
      }
    }
  }

  const { data: players } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name, team, role, fantasy_points, last_updated")
    .eq("match_id", id)
    .order("fantasy_points", { ascending: false })

  return NextResponse.json({ players: players || [] })
}
