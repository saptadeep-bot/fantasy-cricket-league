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
//
// HARDENED on 2026-04-18: the helper duplication between this file and
// finalize/route.ts was lifted into `src/lib/scorecard-sources.ts`.  Both paths
// now call the same `fetchBestScorecard` so they can't drift again.

import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { computeAndSave } from "@/lib/match-scoring"
import { getEntryFee, calcPrizes } from "@/lib/prizes"
import { fetchBestScorecard } from "@/lib/scorecard-sources"
import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60

// ─── Handler ─────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ?force=1 — admin override.  See finalize/route.ts for the full rationale.
  const url = new URL(req.url)
  const force = url.searchParams.get("force") === "1"

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })

  try {
    // Step 1: Fetch scorecard from the richest available source (cricapi and
    // EntitySport /info tried in parallel, richer one wins).  Same helper as
    // finalize/route.ts — they MUST stay in sync or we're right back to the
    // partial-data bug this endpoint was built to fix.
    const { scorecard, source, resolvedEsMatchId } = await fetchBestScorecard(
      match.cricketdata_match_id,
      match.team1 ?? "",
      match.team2 ?? "",
      { cachedEsMatchId: match.entitysport_match_id ?? null },
    )
    // Persist resolved EntitySport match_id.
    if (resolvedEsMatchId && resolvedEsMatchId !== match.entitysport_match_id) {
      await supabaseAdmin
        .from("matches")
        .update({ entitysport_match_id: resolvedEsMatchId })
        .eq("id", id)
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
    // Per-innings sanity check — same as finalize (≥3 batters / ≥3 bowlers
    // post-2026-04-26 retune).  Skip when ?force=1.  See finalize/route.ts
    // for the threshold rationale.
    if (!force) {
      for (let i = 0; i < 2; i++) {
        const inn = scorecard[i] as { batting?: unknown[]; bowling?: unknown[]; inning?: string }
        const batN = inn.batting?.length ?? 0
        const bowlN = inn.bowling?.length ?? 0
        if (batN < 3 || bowlN < 3) {
          return NextResponse.json({
            error: `Innings ${i + 1} (${inn.inning ?? "?"}) looks incomplete: ${batN} batters, ${bowlN} bowlers (source: ${source}). Re-finalize needs ≥3 batters and ≥3 bowlers per innings. Use "Force Re-finalize" if the data IS complete.`,
            canForce: true,
          }, { status: 400 })
        }
      }
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
