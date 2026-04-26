// Admin "Finalize & Pay Out" handler — called once a match has ended to lock
// in fantasy points, rank teams, compute prizes and mark the match completed.
//
// HARDENED on 2026-04-18 after a partial-cricapi bug silently finalized RCB vs
// DC and SRH vs CSK on incomplete data.  Now uses the shared scorecard-sources
// helper which tries cricapi AND EntitySport in parallel and picks the richer
// response, so a mid-populating cricapi or an empty EntitySport each can't
// single-handedly corrupt the results.
//
// See `src/lib/scorecard-sources.ts` for the full rationale and why Cricbuzz
// `/scard` is deliberately excluded from this path.

import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { computeAndSave } from "@/lib/match-scoring"
import { getEntryFee, calcPrizes } from "@/lib/prizes"
import { fetchBestScorecard, countScorecardPlayers } from "@/lib/scorecard-sources"
import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ?force=1 — admin override that skips the per-innings sanity guard.
  // Use ONLY when the data is genuinely complete but happens to look thin
  // (e.g. team posted 145/3 → only 4 batter entries, which the conservative
  // per-innings guard rejects as "partial").  The total≥15 guard still
  // applies so a truly empty scorecard can never be force-finalized.
  const url = new URL(req.url)
  const force = url.searchParams.get("force") === "1"

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  if (match.status === "completed") return NextResponse.json({ error: "Match already finalized" }, { status: 400 })

  try {
    // Step 1: Fetch final scorecard from the best available source.  This runs
    // cricapi + EntitySport in parallel and returns whichever has more players
    // listed — defends against partial cricapi data during the window where
    // `fantasyEnabled` has flipped but the scorecard is still populating.
    const { scorecard, source, resolvedEsMatchId } = await fetchBestScorecard(
      match.cricketdata_match_id,
      match.team1 ?? "",
      match.team2 ?? "",
      { cachedEsMatchId: match.entitysport_match_id ?? null },
    )

    // Persist resolved EntitySport match_id for future live/finalize calls.
    if (resolvedEsMatchId && resolvedEsMatchId !== match.entitysport_match_id) {
      await supabaseAdmin
        .from("matches")
        .update({ entitysport_match_id: resolvedEsMatchId })
        .eq("id", id)
    }

    if (!scorecard || scorecard.length === 0) {
      return NextResponse.json({
        error: "No scorecard data returned from any source (cricapi or EntitySport). Match may not have ended yet, or both APIs are temporarily unavailable. Try again in a minute."
      }, { status: 400 })
    }
    if (scorecard.length < 2) {
      return NextResponse.json({
        error: `Only ${scorecard.length} innings in scorecard (source: ${source}). Both innings must be complete before finalizing.`
      }, { status: 400 })
    }
    // Sanity checks — catch partial-data bugs like the 2026-04-18 incident
    // where cricapi's fantasyEnabled flipped early but its scorecard was
    // still populating player-by-player.  We now enforce BOTH:
    //   (1) total ≥ 15 — blocks thin scorecards (original guard)
    //   (2) each of the first 2 innings has ≥ 3 batters AND ≥ 3 bowlers —
    //       blocks asymmetric partials (innings 1 complete, innings 2 empty)
    //       that the total-only guard would let through.
    //
    // Threshold tuning history:
    //   - 2026-04-18: introduced as ≥5 batters / ≥3 bowlers
    //   - 2026-04-26: lowered to ≥3 batters because cricapi's `batting` array
    //     only contains players who actually came to crease.  A team that
    //     posted 145/3 has just 4 entries (3 dismissed + 1 not-out striker),
    //     and the ≥5 guard incorrectly blocked Punjab vs Delhi finalize.
    //     ≥3 batters still catches the partial-data bug (mid-innings flip
    //     typically has 0–2 entries) without false-positiving on legit
    //     low-wickets innings.
    //
    // Super overs / 3rd innings are not checked — they're optional and often
    // tiny even in well-formed scorecards.
    //
    // ?force=1 admin override skips this per-innings check entirely.  The
    // total≥15 guard still applies so a truly empty scorecard can't slip
    // through even with force.
    const playerCount = countScorecardPlayers(scorecard as unknown[])
    if (playerCount < 15) {
      return NextResponse.json({
        error: `Scorecard looks incomplete — only ${playerCount} batter/bowler entries across both innings (source: ${source}). A full T20 scorecard should have 20+. Wait a minute and try again.`
      }, { status: 400 })
    }
    if (!force) {
      for (let i = 0; i < 2; i++) {
        const inn = scorecard[i] as { batting?: unknown[]; bowling?: unknown[]; inning?: string }
        const batN = inn.batting?.length ?? 0
        const bowlN = inn.bowling?.length ?? 0
        if (batN < 3 || bowlN < 3) {
          return NextResponse.json({
            error: `Innings ${i + 1} (${inn.inning ?? "?"}) looks incomplete: ${batN} batters, ${bowlN} bowlers (source: ${source}). Need ≥3 batters and ≥3 bowlers per innings to finalize safely. If the data IS complete (e.g. low-wickets innings), use the "Force Finalize" button.`,
            canForce: true,
          }, { status: 400 })
        }
      }
    }

    // Step 2: Compute and save all player fantasy points (uses name-matching + auto-insert for impact subs)
    await computeAndSave(id, scorecard)

    // Step 3: Fetch all submitted teams
    const { data: teams } = await supabaseAdmin
      .from("teams")
      .select("*, users(id, name, email)")
      .eq("match_id", id)

    if (!teams || teams.length === 0) {
      await supabaseAdmin.from("matches").update({ status: "completed" }).eq("id", id)
      return NextResponse.json({ success: true, message: "No teams submitted. Match marked complete with no payout.", source })
    }

    // Step 4: Fetch updated match players for point lookup
    const { data: matchPlayers } = await supabaseAdmin
      .from("match_players")
      .select("cricketdata_player_id, fantasy_points")
      .eq("match_id", id)

    const playerPointsMap: Record<string, number> = {}
    for (const mp of (matchPlayers || [])) {
      playerPointsMap[mp.cricketdata_player_id] = mp.fantasy_points || 0
    }

    // Step 5: Compute each user's total points
    const userScores: Array<{ user_id: string; raw_points: number; final_points: number }> = []

    for (const team of teams) {
      const playerIds: string[] = team.player_ids || []
      let finalPoints = 0
      let rawPoints = 0

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

    // Step 6: Rank users (handle ties)
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

    // Step 7: Calculate prizes
    const ENTRY_FEE = getEntryFee(match.match_type)
    const participants = teams.length
    const totalPool = ENTRY_FEE * participants

    const prizeResults = calcPrizes(ranked, totalPool, ENTRY_FEE)
    const results = prizeResults.map(r => ({ ...r, match_id: id }))

    // Step 8: Save results
    await supabaseAdmin.from("match_results").delete().eq("match_id", id)
    const { error: resultsError } = await supabaseAdmin.from("match_results").insert(results)
    if (resultsError) return NextResponse.json({ error: resultsError.message }, { status: 500 })

    // Step 9: Mark match as completed
    await supabaseAdmin.from("matches").update({ status: "completed" }).eq("id", id)

    return NextResponse.json({
      success: true,
      source,
      participants,
      totalPool,
      results: results.map(r => ({
        user_id: r.user_id,
        rank: r.rank,
        final_points: r.final_points,
        prize_won: r.prize_won,
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
