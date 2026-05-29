// Server-driven cron poller for live matches.
//
// Why this exists: the rest of the live-scoring pipeline is viewer-driven.
// LiveMatchView.tsx triggers fetches via setInterval, the Refresh button,
// and visibility-change handlers — but when EVERY viewer closes/backgrounds
// their tab, no polls fire and data freezes.  Q2 (RR vs GT) on 2026-05-29
// hit this for 20+ minutes when friends closed the match tab after toss.
//
// This cron is configured in `vercel.json` to fire every minute.  It:
//   1. Verifies Vercel's Authorization: Bearer <CRON_SECRET> header (Vercel
//      sets this automatically when CRON_SECRET is in env vars).
//   2. Queries matches table for status='live'.
//   3. For each live match, calls fetchBestScorecardLive + computeAndSave —
//      same path as the participant auto-poll, just without the human in
//      the loop.
//   4. Updates last_live_fetch_at + persists resolved match-id caches.
//
// Combined with the existing 25s server-side cache, the cron-driven polls
// dedupe naturally with viewer-driven polls: when a viewer is active and
// polling every 30s, the cron's 1-min hit usually finds the cache fresh
// and skips external fetch.  When no viewers are active, the cron drives
// data freshness on its own.
//
// Cricapi quota impact: ~60 cron hits/hour during a live match, plus
// viewer-driven hits.  Both deduplicate at the 25s cache, so worst-case
// is ~144 external fetches/hour (one per cache window).  Cricapi default
// quota is 10k/day → way more than enough.

import { supabaseAdmin } from "@/lib/supabase"
import { fetchBestScorecardLive } from "@/lib/scorecard-sources"
import { computeAndSave } from "@/lib/match-scoring"
import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  // Vercel cron auth.  When CRON_SECRET is set as an env var, Vercel adds
  // `Authorization: Bearer <CRON_SECRET>` to every cron-triggered request.
  // This blocks public access — only Vercel's scheduler (or anyone with
  // the secret) can trigger the poll.
  const authHeader = req.headers.get("authorization") ?? ""
  const expected = process.env.CRON_SECRET
  if (expected) {
    if (authHeader !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  } else {
    // No CRON_SECRET configured — refuse rather than expose the endpoint.
    // Admin must set CRON_SECRET in Vercel env before cron starts working.
    return NextResponse.json({
      error: "CRON_SECRET not configured. Set it in Vercel env vars.",
    }, { status: 503 })
  }

  // Find all currently-live matches.  Defensive SELECT * in case
  // entitysport_match_id or cricbuzz_match_id columns are missing.
  const { data: liveMatches, error: queryErr } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("status", "live")

  if (queryErr) {
    return NextResponse.json({ error: queryErr.message }, { status: 500 })
  }

  if (!liveMatches || liveMatches.length === 0) {
    return NextResponse.json({
      polled: 0,
      message: "No live matches",
      ts: new Date().toISOString(),
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: Array<Record<string, any>> = []

  for (const match of liveMatches) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = match as Record<string, any>
    const matchId = m.id as string
    const cricketdataMatchId = (m.cricketdata_match_id as string | undefined) ?? ""
    const team1 = (m.team1 as string | undefined) ?? ""
    const team2 = (m.team2 as string | undefined) ?? ""

    if (!cricketdataMatchId) {
      results.push({ id: matchId, skipped: "no cricetdata_match_id" })
      continue
    }

    try {
      const fetchResult = await fetchBestScorecardLive(
        cricketdataMatchId,
        team1,
        team2,
        {
          cachedEsMatchId: (m.entitysport_match_id as string | null | undefined) ?? null,
          cachedCbMatchId: (m.cricbuzz_match_id as string | null | undefined) ?? null,
        },
      )

      // Persist resolved match-id caches if changed, plus stamp last_live_fetch_at
      // so viewer auto-polls within the next 25s skip their external fetch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updates: Record<string, any> = {
        last_live_fetch_at: new Date().toISOString(),
      }
      if (fetchResult.resolvedEsMatchId !== (m.entitysport_match_id ?? null)) {
        updates.entitysport_match_id = fetchResult.resolvedEsMatchId
      }
      if (fetchResult.resolvedCbMatchId !== (m.cricbuzz_match_id ?? null)) {
        updates.cricbuzz_match_id = fetchResult.resolvedCbMatchId
      }
      try {
        await supabaseAdmin.from("matches").update(updates).eq("id", matchId)
      } catch {
        // Column may not exist — defensive; don't fail the whole cron run.
      }

      if (fetchResult.scorecard) {
        const computeResult = await computeAndSave(matchId, fetchResult.scorecard)
        results.push({
          id: matchId,
          source: fetchResult.source,
          updated: computeResult.updated,
          total: computeResult.total,
          autoAdded: computeResult.autoAdded,
          dropped: computeResult.dropped?.length ?? 0,
        })
      } else {
        results.push({
          id: matchId,
          source: "none",
          liveInProgress: fetchResult.liveInProgress ?? false,
          notStarted: fetchResult.notStarted ?? false,
          detail: fetchResult.detail.slice(0, 200),
        })
      }
    } catch (e) {
      results.push({
        id: matchId,
        error: String(e).replace(/^Error:\s*/, "").slice(0, 200),
      })
    }
  }

  return NextResponse.json({
    polled: results.length,
    results,
    ts: new Date().toISOString(),
  })
}
