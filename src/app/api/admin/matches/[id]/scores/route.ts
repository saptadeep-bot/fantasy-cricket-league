import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

async function computeAndSave(matchId: string, scorecard: unknown[]) {
  const pointsMap = calculateFantasyPoints(scorecard)
  let updated = 0
  for (const [playerId, pts] of pointsMap.entries()) {
    const { error } = await supabaseAdmin
      .from("match_players")
      .update({ fantasy_points: Math.round(pts.total * 10) / 10, last_updated: new Date().toISOString() })
      .eq("match_id", matchId)
      .eq("cricketdata_player_id", playerId)
    if (!error) updated++
  }
  return { updated, total: pointsMap.size }
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
