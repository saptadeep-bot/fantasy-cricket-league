// Re-finalize an already-completed match.
//
// Rationale: on 2026-04-18 two matches (RCB vs DC, SRH vs CSK) were finalized
// while Cricbuzz's RapidAPI quota was exhausted AND cricapi had fantasyEnabled:
// false mid-innings.  Finalize pulled partial / incorrect scorecards and the
// resulting match_results (ranks + prizes) were wrong.  Now that the matches
// have ended, cricapi has full fantasyEnabled:true scorecards available.
//
// This endpoint recomputes everything from the current scorecard and overwrites
// match_results.  It preserves `is_settled` flags per user so manually-cleared
// payouts aren't marked pending again.
//
// The match status stays "completed" throughout — this is a correction, not a
// re-opening of the match.

import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { computeAndSave } from "@/lib/match-scoring"
import { getEntryFee, calcPrizes } from "@/lib/prizes"
import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!
const CRICBUZZ_API_KEY = process.env.CRICBUZZ_API_KEY

// ─── Scorecard fetch (cricapi primary, EntitySport /info fallback) ───────────
// Kept inline rather than importing from scores/route.ts because Next.js App
// Router route files aren't meant to be imported from elsewhere.  The two paths
// below cover the two cases we care about for a completed match:
//   1. cricapi match_scorecard returns full data (fantasyEnabled:true after
//      match ends) — this is the common case once the match has ended.
//   2. EntitySport /matches/{id}/info returns a full raw scorecard which we
//      convert to cricapi-compatible shape — backup if cricapi is still
//      serving partial data.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractScorecard(data: any): unknown[] | null {
  if (!data) return null
  if (Array.isArray(data.data?.scorecard) && data.data.scorecard.length > 0) return data.data.scorecard
  if (Array.isArray(data.data) && data.data.length > 0 && data.data[0]?.batting) return data.data
  if (data.data?.batting || data.data?.bowling) return [data.data]
  return null
}

async function fetchCricapiScorecard(cricketdataMatchId: string): Promise<unknown[] | null> {
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${cricketdataMatchId}`,
      { cache: "no-store" }
    )
    const data = await res.json()
    if (data.status !== "success") return null
    return extractScorecard(data)
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertEntitySportScorecard(innings: any[]): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return innings.map((inn: any) => {
    const battingTeam = inn.name ?? "Unknown"
    const inningsId = inn.number ?? 1

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batting = (inn.batsmen ?? []).map((b: any) => ({
      id: "es_" + (b.batsman_id ?? b.id ?? ""),
      name: b.name ?? "",
      r: Number(b.runs ?? 0),
      b: Number(b.balls_faced ?? 0),
      "4s": Number(b.fours ?? 0),
      "6s": Number(b.sixes ?? 0),
      "dismissal-text": b.how_out ?? "",
      dismissal: b.how_out ?? "",
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bowling = (inn.bowlers ?? []).map((bw: any) => ({
      id: "es_" + (bw.bowler_id ?? bw.id ?? ""),
      name: bw.name ?? "",
      o: bw.overs ?? 0,
      m: Number(bw.maidens ?? 0),
      r: Number(bw.runs_conceded ?? 0),
      w: Number(bw.wickets ?? 0),
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catching = (inn.fielder ?? []).map((f: any) => {
      const catches = Number(f.catches ?? 0)
      const stumped = Number(f.stumping ?? 0)
      const thrower = Number(f.runout_thrower ?? 0)
      const catcher = Number(f.runout_catcher ?? 0)
      const direct = Number(f.runout_direct_hit ?? 0)
      return {
        id: "es_" + (f.fielder_id ?? ""),
        name: f.fielder_name ?? "",
        catch: catches,
        stumped,
        runout: direct + Math.max(thrower, catcher),
        cb: 0,
      }
    })

    return { inning: `${battingTeam} ${inningsId}`, batting, bowling, catching }
  })
}

async function fetchEntitySportScorecard(team1: string, team2: string): Promise<unknown[] | null> {
  if (!CRICBUZZ_API_KEY) return null
  try {
    const headers = {
      "x-rapidapi-key": CRICBUZZ_API_KEY,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }

    // Search a few dates around today to handle matches that ended yesterday
    const now = Date.now()
    const dates = [0, -1, -2].map(d =>
      new Date(now + d * 86_400_000).toISOString().slice(0, 10)
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allMatches: any[] = []
    for (const date of dates) {
      try {
        const r = await fetch(
          `https://cricket-live-line-advance.p.rapidapi.com/matches?date=${date}`,
          { headers, cache: "no-store" }
        )
        if (!r.ok) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = await r.json()
        const arr = Array.isArray(d?.response?.items) ? d.response.items : null
        if (arr) allMatches.push(...arr)
      } catch { continue }
    }
    if (allMatches.length === 0) return null

    const tokens = (name: string): string[] => {
      const parts = name.toLowerCase().split(/\s+/).filter(Boolean)
      const toks = new Set<string>([name.toLowerCase(), ...parts])
      if (parts.length >= 2) toks.add(parts.map(p => p[0]).join(""))
      return Array.from(toks).filter(t => t.length >= 2)
    }
    const t1 = tokens(team1)
    const t2 = tokens(team2)
    const hits = (haystack: string, toks: string[]) =>
      toks.some(t => haystack.includes(t))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = allMatches.find((m: any) => {
      const haystack = [
        m.title ?? "", m.short_title ?? "",
        m.teama?.name ?? "", m.teama?.short_name ?? "",
        m.teamb?.name ?? "", m.teamb?.short_name ?? "",
      ].join(" ").toLowerCase()
      return hits(haystack, t1) && hits(haystack, t2)
    })
    if (!found) return null

    const esMatchId = found.match_id ?? found.id
    if (!esMatchId) return null

    const infoRes = await fetch(
      `https://cricket-live-line-advance.p.rapidapi.com/matches/${esMatchId}/info`,
      { headers, cache: "no-store" }
    )
    if (!infoRes.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const infoData: any = await infoRes.json()

    const innings = infoData?.response?.scorecard?.innings
    if (!Array.isArray(innings) || innings.length === 0) return null

    const converted = convertEntitySportScorecard(innings)
    const hasPlayers = converted.some((inn: unknown) => {
      const i = inn as { batting?: unknown[]; bowling?: unknown[] }
      return (i.batting?.length ?? 0) > 0 || (i.bowling?.length ?? 0) > 0
    })
    return hasPlayers ? converted : null
  } catch {
    return null
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })

  try {
    // Step 1: Fetch scorecard — try cricapi first (richest format), then EntitySport
    let scorecard = await fetchCricapiScorecard(match.cricketdata_match_id)
    let source = "cricapi"
    if (!scorecard || scorecard.length === 0) {
      scorecard = await fetchEntitySportScorecard(match.team1 ?? "", match.team2 ?? "")
      source = "entitysport-info"
    }
    if (!scorecard || scorecard.length === 0) {
      return NextResponse.json({
        error: "Could not fetch a full scorecard from any source. Try again in a few minutes.",
      }, { status: 400 })
    }
    if (scorecard.length < 2) {
      return NextResponse.json({
        error: `Scorecard only has ${scorecard.length} innings (source: ${source}). Both innings must be complete before re-finalizing.`,
      }, { status: 400 })
    }

    // Step 2: Recompute match_players.fantasy_points from scratch
    const compResult = await computeAndSave(id, scorecard)

    // Step 3: Re-read match players (now with corrected points)
    const { data: matchPlayers } = await supabaseAdmin
      .from("match_players")
      .select("cricketdata_player_id, fantasy_points")
      .eq("match_id", id)

    const playerPointsMap: Record<string, number> = {}
    for (const mp of matchPlayers || []) {
      playerPointsMap[mp.cricketdata_player_id] = mp.fantasy_points || 0
    }

    // Step 4: Fetch all teams for this match
    const { data: teams } = await supabaseAdmin
      .from("teams")
      .select("*")
      .eq("match_id", id)

    if (!teams || teams.length === 0) {
      return NextResponse.json({
        success: true,
        message: "Scores recomputed, but no teams to rank for this match.",
        source,
        computeResult: compResult,
      })
    }

    // Step 5: Preserve is_settled flags from existing match_results so manually
    // cleared payouts don't get un-settled
    const { data: existingResults } = await supabaseAdmin
      .from("match_results")
      .select("user_id, is_settled")
      .eq("match_id", id)
    const settledMap: Record<string, boolean> = {}
    for (const r of existingResults || []) {
      settledMap[r.user_id] = !!r.is_settled
    }

    // Step 6: Compute each user's total points with captain/VC multipliers
    const userScores: Array<{ user_id: string; raw_points: number; final_points: number }> = []
    for (const team of teams) {
      const playerIds: string[] = team.player_ids || []
      let rawPoints = 0
      let finalPoints = 0
      for (const pid of playerIds) {
        const rawPts = playerPointsMap[pid] || 0
        rawPoints += rawPts
        let multiplier = 1.0
        if (pid === team.captain_id) multiplier = 2.0
        else if (pid === team.vice_captain_id) multiplier = 1.5
        finalPoints += rawPts * multiplier
      }
      userScores.push({
        user_id: team.user_id,
        raw_points: Math.round(rawPoints * 10) / 10,
        final_points: Math.round(finalPoints * 10) / 10,
      })
    }

    // Step 7: Rank with tie handling (same logic as finalize)
    userScores.sort((a, b) => b.final_points - a.final_points)
    const ranked: Array<(typeof userScores)[0] & { rank: number }> = []
    let currentRank = 1
    for (let i = 0; i < userScores.length; i++) {
      if (i > 0 && userScores[i].final_points === userScores[i - 1].final_points) {
        ranked.push({ ...userScores[i], rank: ranked[i - 1].rank })
      } else {
        ranked.push({ ...userScores[i], rank: currentRank })
      }
      currentRank++
    }

    // Step 8: Compute prizes
    const ENTRY_FEE = getEntryFee(match.match_type)
    const participants = teams.length
    const totalPool = ENTRY_FEE * participants
    const prizeResults = calcPrizes(ranked, totalPool, ENTRY_FEE)

    const results = prizeResults.map(r => ({
      ...r,
      match_id: id,
      is_settled: settledMap[r.user_id] ?? false,
    }))

    // Step 9: Rewrite match_results (delete + insert is safe because settled
    // flags are restored from settledMap above)
    await supabaseAdmin.from("match_results").delete().eq("match_id", id)
    const { error: insertError } = await supabaseAdmin
      .from("match_results")
      .insert(results)
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    // Keep match status as "completed" (don't flip it)
    await supabaseAdmin
      .from("matches")
      .update({ status: "completed" })
      .eq("id", id)

    return NextResponse.json({
      success: true,
      source,
      participants,
      totalPool,
      computeResult: compResult,
      results: results.map(r => ({
        user_id: r.user_id,
        rank: r.rank,
        raw_points: r.raw_points,
        final_points: r.final_points,
        prize_won: r.prize_won,
        is_settled: r.is_settled,
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
