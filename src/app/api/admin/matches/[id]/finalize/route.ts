import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

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
  if (match.status === "completed") return NextResponse.json({ error: "Match already finalized" }, { status: 400 })

  try {
    // Step 1: Fetch final scorecard and calculate points using custom IPL ruleset
    const res = await fetch(
      `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${match.cricketdata_match_id}`
    )
    const data = await res.json()

    const scorecard = data.data?.scorecard || []
    const fantasyPointsMap = calculateFantasyPoints(scorecard)

    // Build points lookup map and update match_players
    const pointsMap: Record<string, number> = {}
    for (const [playerId, pts] of fantasyPointsMap.entries()) {
      pointsMap[playerId] = Math.round(pts.total * 10) / 10
    }

    // Update all match_players with final points
    for (const [playerId, points] of Object.entries(pointsMap)) {
      await supabaseAdmin
        .from("match_players")
        .update({ fantasy_points: points, last_updated: new Date().toISOString() })
        .eq("match_id", id)
        .eq("cricketdata_player_id", playerId)
    }

    // Step 2: Fetch all submitted teams for this match
    const { data: teams } = await supabaseAdmin
      .from("teams")
      .select("*, users(id, name, email)")
      .eq("match_id", id)

    if (!teams || teams.length === 0) {
      // No teams submitted — mark abandoned
      await supabaseAdmin.from("matches").update({ status: "completed" }).eq("id", id)
      return NextResponse.json({ success: true, message: "No teams submitted. Match marked complete with no payout." })
    }

    // Step 3: Fetch match players for point lookup
    const { data: matchPlayers } = await supabaseAdmin
      .from("match_players")
      .select("cricketdata_player_id, fantasy_points")
      .eq("match_id", id)

    const playerPointsMap: Record<string, number> = {}
    for (const mp of (matchPlayers || [])) {
      playerPointsMap[mp.cricketdata_player_id] = mp.fantasy_points || 0
    }

    // Step 4: Compute each user's total points
    const userScores: Array<{
      user_id: string
      raw_points: number
      final_points: number
    }> = []

    for (const team of teams) {
      const playerIds: string[] = team.player_ids || []
      let finalPoints = 0

      for (const pid of playerIds) {
        const rawPts = playerPointsMap[pid] || 0
        let multiplier = 1.0
        if (pid === team.captain_id) multiplier = 2.0
        else if (pid === team.vice_captain_id) multiplier = 1.5
        finalPoints += rawPts * multiplier
      }

      // raw_points = sum without multiplier
      const rawPoints = playerIds.reduce((sum, pid) => sum + (playerPointsMap[pid] || 0), 0)

      userScores.push({
        user_id: team.user_id,
        raw_points: Math.round(rawPoints * 10) / 10,
        final_points: Math.round(finalPoints * 10) / 10,
      })
    }

    // Step 5: Rank users (handle ties)
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

    // Step 6: Calculate prizes
    const participants = teams.length
    const basePrizePool = (match.base_prize || 0) + (match.rollover_added || 0)
    const actualPrizePool = basePrizePool * (participants / 5)
    const unspent = basePrizePool * ((5 - participants) / 5)

    const results: Array<{
      match_id: string
      user_id: string
      rank: number
      raw_points: number
      final_points: number
      prize_won: number
    }> = []

    if (participants < 3) {
      // No payout — rollover to next match
      const { data: nextMatch } = await supabaseAdmin
        .from("matches")
        .select("id, rollover_added, base_prize")
        .eq("status", "upcoming")
        .order("scheduled_at", { ascending: true })
        .limit(1)
        .single()

      if (nextMatch) {
        await supabaseAdmin
          .from("matches")
          .update({ rollover_added: (nextMatch.rollover_added || 0) + basePrizePool })
          .eq("id", nextMatch.id)
      }

      for (const r of ranked) {
        results.push({ match_id: id, user_id: r.user_id, rank: r.rank, raw_points: r.raw_points, final_points: r.final_points, prize_won: 0 })
      }
    } else {
      // Determine winners
      const firstPlaceScore = ranked[0].final_points
      const firstPlacers = ranked.filter(r => r.final_points === firstPlaceScore)

      let secondPlacers: typeof ranked = []
      if (participants >= 4) {
        // Find 2nd place (only if there are participants not in 1st place)
        const nonFirst = ranked.filter(r => r.final_points < firstPlaceScore)
        if (nonFirst.length > 0) {
          const secondPlaceScore = nonFirst[0].final_points
          secondPlacers = nonFirst.filter(r => r.final_points === secondPlaceScore)
        }
      }

      const firstPrize = actualPrizePool * 0.65
      const secondPrize = actualPrizePool * 0.35

      // If all participants tie for 1st (no 2nd place), split everything
      const totalFirstPrize = secondPlacers.length === 0 ? actualPrizePool : firstPrize
      const prizePerFirst = totalFirstPrize / firstPlacers.length
      const prizePerSecond = secondPlacers.length > 0 ? secondPrize / secondPlacers.length : 0

      for (const r of ranked) {
        let prize = 0
        if (firstPlacers.find(f => f.user_id === r.user_id)) prize = prizePerFirst
        else if (secondPlacers.find(s => s.user_id === r.user_id)) prize = prizePerSecond
        results.push({
          match_id: id,
          user_id: r.user_id,
          rank: r.rank,
          raw_points: r.raw_points,
          final_points: r.final_points,
          prize_won: Math.round(prize * 100) / 100,
        })
      }

      // Add unspent to season reserve
      if (unspent > 0) {
        await supabaseAdmin.from("season_reserve").insert({
          match_id: id,
          amount: Math.round(unspent * 100) / 100,
          reason: "low_participation",
        })
      }
    }

    // Step 7: Save results
    await supabaseAdmin.from("match_results").delete().eq("match_id", id)
    const { error: resultsError } = await supabaseAdmin.from("match_results").insert(results)
    if (resultsError) return NextResponse.json({ error: resultsError.message }, { status: 500 })

    // Step 8: Mark match as completed
    await supabaseAdmin.from("matches").update({ status: "completed" }).eq("id", id)

    return NextResponse.json({
      success: true,
      participants,
      results: results.map(r => ({ user_id: r.user_id, rank: r.rank, final_points: r.final_points, prize_won: r.prize_won }))
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
