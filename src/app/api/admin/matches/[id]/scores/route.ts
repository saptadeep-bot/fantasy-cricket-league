// Live-poll + admin-refresh endpoint for a single match's scorecard.
//
// REFACTORED on 2026-04-22 — the inline cricapi + EntitySport + Cricbuzz
// helpers that used to live here have been lifted into
// `src/lib/scorecard-sources.ts` so this path and the finalize/refinalize
// paths can no longer drift.  In the week prior, the inline duplicates got
// out-of-sync twice (±1-day date window, then listing-endpoint aggregation)
// and the live path broke while finalize was still fine.  Now every caller
// funnels through the shared `fetchBestScorecardLive()` which runs cricapi
// and EntitySport in parallel on every poll and picks whichever returned
// more batter+bowler entries.  That's the only way to survive the
// intermittent failure modes we've seen:
//   - cricapi has fantasyEnabled:true mid-innings but only a partial (10-
//     player) scorecard (2026-04-21 bug)
//   - EntitySport's date-listing cache lags behind live-listing (commit
//     7241093 — the break-on-first-non-empty regression)
//   - Cricbuzz monthly quota exhausted (2026-04-18)
//   - cricapi fantasyEnabled flips while the match is still live but
//     EntitySport has full data (2026-04-19)
// The live-specific extras this route keeps:
//   - `findLiveMatchId` — cricapi `currentMatches` lookup to re-map a stale
//     stored `cricketdata_match_id` to a new one mid-series.
//   - `tryEntitySportDirect` (newpoint2) — ULTIMATE last resort with the
//     wrong scoring formula.  Only fires when both cricapi and EntitySport
//     /info came back empty.  Not used by finalize — wrong scores are worse
//     than no scores when prizes are being paid out.
//
// The live path intentionally does NOT enforce the finalize-side `playerCount
// < 15` hard refusal — during live play, 3 batters in the first innings is
// valid data and should be shown.  For finalize we demand 15+; for live we
// just want the richest we can get right now.

import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { computeAndSave, namesMatch } from "@/lib/match-scoring"
import { fetchBestScorecardLive } from "@/lib/scorecard-sources"
import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60
// Force dynamic rendering so Next.js never statically caches this handler's
// output at build time or via its data cache.  We also set Cache-Control:
// no-store on every response below — together these stop browsers, Vercel's
// edge cache, and any intermediate proxy from replaying stale responses to
// the participant auto-poll (which was the 2026-04-20 frozen-scores bug).
export const dynamic = "force-dynamic"
export const revalidate = 0

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
} as const

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!
const CRICBUZZ_API_KEY = process.env.CRICBUZZ_API_KEY

// ─── Types ────────────────────────────────────────────────────────────────────

interface FetchResult {
  updated: number
  total: number
  remapped: number
  autoAdded: number
  missed: string[]
  liveInProgress?: boolean
  notStarted?: boolean
  source?: string
  lastDetail?: string
}

// ─── cricapi currentMatches remap ─────────────────────────────────────────────
// Used only when the stored `cricketdata_match_id` has gone stale (cricapi
// sometimes issues a new ID for the same fixture mid-tournament).  We look up
// by team names, update the DB, and let the next poll re-fetch with the
// corrected ID.  Not worth extracting to the shared lib — finalize never
// needs it because by the time a match ends, any ID drift would have been
// caught during live polling.

async function findLiveMatchId(team1: string, team2: string): Promise<string | null> {
  const [p0, p1] = await Promise.all([
    fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=0`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
    fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=25`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
  ])

  const liveMatches: { id: string; name?: string; teams?: string[] }[] = [
    ...(p0.data || []),
    ...(p1.data || []),
  ]

  const tokens = (name: string) => [
    name.toLowerCase(),
    name.split(" ").pop()!.toLowerCase(),
    name.split(" ")[0].toLowerCase(),
  ]

  const t1 = tokens(team1)
  const t2 = tokens(team2)
  const hits = (haystack: string, toks: string[]) =>
    toks.some(t => haystack.toLowerCase().includes(t))

  const found = liveMatches.find(m => {
    const haystack = [...(m.teams || []), m.name || ""].join(" ")
    return hits(haystack, t1) && hits(haystack, t2)
  })

  return found?.id ?? null
}

// ─── EntitySport newpoint2 (LAST RESORT — wrong scoring formula) ──────────────
// EntitySport's pre-computed /newpoint2 points use its own scoring formula
// which does NOT match Dream11 (e.g. wickets worth different multipliers).  We
// keep this helper purely as a "some points are better than none" fallback
// when every real scorecard source has failed.  Must NOT run when we have a
// valid scorecard — it would clobber correct Dream11 points with wrong ones.
async function tryEntitySportDirect(
  matchId: string,
  team1: string,
  team2: string,
  apiKey: string
): Promise<FetchResult | null> {
  try {
    const headers = {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allMatches: any[] = []
    for (const url of [
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=2",   // live
      "https://cricket-live-line-advance.p.rapidapi.com/livematches",
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=3",   // completed
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=live",
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=1",   // scheduled
    ]) {
      try {
        const r = await fetch(url, { headers, cache: "no-store" })
        if (!r.ok) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = await r.json()
        const arr = Array.isArray(d) ? d
          : Array.isArray(d?.response) ? d.response
          : Array.isArray(d?.response?.items) ? d.response.items
          : Array.isArray(d?.response?.data) ? d.response.data
          : Array.isArray(d?.response?.matches) ? d.response.matches
          : Array.isArray(d?.data) ? d.data
          : null
        if (arr && arr.length > 0) { allMatches = arr; break }
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
      const str = JSON.stringify(m).toLowerCase()
      return hits(str, t1) && hits(str, t2)
    })
    if (!found) return null

    const esMatchId = found.match_id ?? found.id ?? found.matchId
    if (!esMatchId) return null

    const ptsRes = await fetch(
      `https://cricket-live-line-advance.p.rapidapi.com/matches/${esMatchId}/newpoint2`,
      { headers, cache: "no-store" }
    )
    if (!ptsRes.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ptsData: any = await ptsRes.json()

    const pts = ptsData?.response?.points ?? ptsData?.points
    if (!pts) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allPlayers: any[] = [
      ...(pts.teama?.playing11 ?? []),
      ...(pts.teamb?.playing11 ?? []),
    ]
    if (allPlayers.length === 0) return null

    const { data: dbPlayers } = await supabaseAdmin
      .from("match_players")
      .select("cricketdata_player_id, name")
      .eq("match_id", matchId)
    const dbList = (dbPlayers || []).map((p: { cricketdata_player_id: string; name: string }) => ({
      id: p.cricketdata_player_id,
      name: p.name,
    }))

    const now = new Date().toISOString()
    let updated = 0

    for (const player of allPlayers) {
      const fantasyPoints = parseFloat(player.point ?? "0") || 0
      if (fantasyPoints === 0) continue

      const matched = dbList.find((p: { id: string; name: string }) =>
        namesMatch(player.name, p.name)
      )
      if (!matched) continue

      const { error } = await supabaseAdmin
        .from("match_players")
        .update({ fantasy_points: fantasyPoints, last_updated: now })
        .eq("match_id", matchId)
        .eq("cricketdata_player_id", matched.id)
      if (!error) updated++
    }

    return { updated, total: allPlayers.length, remapped: 0, autoAdded: 0, missed: [] }
  } catch {
    return null
  }
}

// ─── Main fetch path ──────────────────────────────────────────────────────────

async function fetchAndSaveScores(matchId: string, cricketdataMatchId: string): Promise<FetchResult> {
  // Defensive read: SELECT * instead of naming `entitysport_match_id` /
  // `cricbuzz_match_id` explicitly.  If the migration hasn't been run yet,
  // PostgREST returns a 400 on `.select("...entitysport_match_id...")` and
  // the entire live-poll path breaks.  SELECT * degrades gracefully — the
  // field is just `undefined` on older schemas and we fall back to the
  // listing-aggregation path (slower but correct).
  const { data: matchRow } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", matchId)
    .single()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (matchRow ?? {}) as Record<string, any>
  const team1 = (m.team1 as string | undefined) ?? ""
  const team2 = (m.team2 as string | undefined) ?? ""
  const cachedEsMatchId = (m.entitysport_match_id as string | null | undefined) ?? null
  const cachedCbMatchId = (m.cricbuzz_match_id as string | null | undefined) ?? null

  // Step 1: richest scorecard from (cricapi + EntitySport) in parallel.  This
  // is the single unified path — see `scorecard-sources.ts` for why.  Pass
  // cached match IDs so the listing-aggregation step is skipped when we've
  // already resolved them on a prior poll (cuts ~10 RapidAPI calls/poll).
  const first = await fetchBestScorecardLive(cricketdataMatchId, team1, team2, {
    cachedEsMatchId,
    cachedCbMatchId,
  })
  let scorecard = first.scorecard
  let source = first.source
  let liveInProgress = first.liveInProgress
  let notStarted = first.notStarted
  let lastDetail = `stored ID (${cricketdataMatchId}): ${first.detail}`

  // Persist resolved match IDs so subsequent polls skip the listing aggregation.
  // Wrapped in try/catch: if the column doesn't exist yet (migration not run),
  // we swallow the error so the scores path stays up — we just pay the
  // listing-aggregation cost on the next poll.  Better to waste quota than
  // to 500 during a live match.
  const updates: Record<string, string | null> = {}
  if (first.resolvedEsMatchId !== cachedEsMatchId) updates.entitysport_match_id = first.resolvedEsMatchId
  if (first.resolvedCbMatchId !== cachedCbMatchId) updates.cricbuzz_match_id = first.resolvedCbMatchId
  if (Object.keys(updates).length > 0) {
    try {
      const { error: updErr } = await supabaseAdmin.from("matches").update(updates).eq("id", matchId)
      if (updErr) lastDetail += ` | cache-persist skipped: ${updErr.message.slice(0, 80)}`
    } catch (e) {
      lastDetail += ` | cache-persist threw: ${String(e).slice(0, 80)}`
    }
  }

  // Step 2: cricapi ID remap via currentMatches.  Only relevant when we got
  // NOTHING from either source — that's typically a stale stored
  // cricketdata_match_id (cricapi occasionally issues a new ID mid-series).
  // If we already have a scorecard (even a thin one), skip this — the shared
  // lib already tried EntitySport in parallel.
  if (!scorecard && !liveInProgress && !notStarted && team1 && team2) {
    const foundId = await findLiveMatchId(team1, team2)
    lastDetail += ` | currentMatches lookup: ${foundId ?? "not found"}`
    if (foundId && foundId !== cricketdataMatchId) {
      await supabaseAdmin
        .from("matches")
        .update({ cricketdata_match_id: foundId })
        .eq("id", matchId)
      // Retry the unified fetch with the corrected ID
      const retry = await fetchBestScorecardLive(foundId, team1, team2)
      if (retry.scorecard) {
        scorecard = retry.scorecard
        source = `remap → ${retry.source}`
        liveInProgress = false
        notStarted = false
      } else {
        liveInProgress = retry.liveInProgress
        notStarted = retry.notStarted
      }
      lastDetail += ` | retry (${foundId}): ${retry.detail}`
    }
  }

  // Step 3: EntitySport newpoint2 — LAST RESORT.  Wrong scoring formula but
  // better than zero while a match is playing out and every proper source has
  // silently failed.  Must NOT run when we already have a scorecard.
  if (!scorecard && !notStarted && CRICBUZZ_API_KEY && team1 && team2) {
    const esResult = await tryEntitySportDirect(matchId, team1, team2, CRICBUZZ_API_KEY)
    if (esResult) {
      lastDetail += ` | entitysport-newpoint2: ${esResult.updated}/${esResult.total}`
      return { ...esResult, source: "entitysport-newpoint2 (WRONG formula)", lastDetail }
    }
    lastDetail += " | entitysport-newpoint2: not found"
  }

  // Primary: compute Dream11 points from the raw scorecard
  if (scorecard) {
    const scorecardResult = await computeAndSave(matchId, scorecard)
    lastDetail += ` | computeAndSave: ${scorecardResult.updated}/${scorecardResult.total}`
    return { ...scorecardResult, source, lastDetail }
  }

  if (liveInProgress) return { updated: 0, total: 0, remapped: 0, autoAdded: 0, missed: [], liveInProgress: true, lastDetail }
  if (notStarted) return { updated: 0, total: 0, remapped: 0, autoAdded: 0, missed: [], notStarted: true, lastDetail }
  throw new Error(`Scorecard unavailable. Debug: ${lastDetail}`)
}

// ─── DB read helpers ──────────────────────────────────────────────────────────
async function readPlayersFromDb(matchId: string) {
  // SELECT * so we get points_breakdown (added 2026-04-28) without hard-
  // wiring the column.  If the migration hasn't been run yet, the column
  // is just missing from the rows — the client treats that as "breakdown
  // not available" rather than 400-ing on the read.
  const { data } = await supabaseAdmin
    .from("match_players")
    .select("*")
    .eq("match_id", matchId)
    .order("fantasy_points", { ascending: false })
  return data || []
}

async function readTeamsFromDb(matchId: string) {
  const { data } = await supabaseAdmin
    .from("teams")
    .select("id, user_id, player_ids, captain_id, vice_captain_id, users(id, name)")
    .eq("match_id", matchId)
  return data || []
}

// ─── Admin POST: force-fetch ──────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS })
  }

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("cricketdata_match_id, status")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404, headers: NO_CACHE_HEADERS })

  try {
    const result = await fetchAndSaveScores(id, match.cricketdata_match_id)

    if (result.liveInProgress) {
      const players = await readPlayersFromDb(id)
      // Include lastDetail so admin can diagnose why both sources came back
      // empty (the canned message alone is useless when it's actually broken).
      const detailSuffix = result.lastDetail ? ` [debug: ${result.lastDetail}]` : ""
      return NextResponse.json({
        success: false,
        liveInProgress: true,
        error: `Match is currently live — scores are refreshing automatically every 60 seconds. If points aren't showing yet, they'll appear shortly.${detailSuffix}`,
        lastDetail: result.lastDetail,
        players,
      }, { headers: NO_CACHE_HEADERS })
    }

    if (result.notStarted) {
      const players = await readPlayersFromDb(id)
      return NextResponse.json({
        success: false,
        notStarted: true,
        error: "Match hasn't started yet. Scores will be available once the match begins.",
        lastDetail: result.lastDetail,
        players,
      }, { headers: NO_CACHE_HEADERS })
    }

    const players = await readPlayersFromDb(id)
    const msg = [
      `Updated ${result.updated}/${result.total} player scores`,
      result.remapped > 0 ? `${result.remapped} ID remapped` : "",
      result.autoAdded > 0 ? `${result.autoAdded} new player(s) added (${result.missed.length === 0 ? "OK" : result.missed.join(", ")})` : "",
    ].filter(Boolean).join(". ")
    return NextResponse.json({ success: true, players, ...result, message: msg }, { headers: NO_CACHE_HEADERS })
  } catch (err) {
    return NextResponse.json({ error: String(err).replace(/^Error:\s*/, "") }, { status: 400, headers: NO_CACHE_HEADERS })
  }
}

// ─── Public GET ───────────────────────────────────────────────────────────────
// ?refresh=1 / ?force=true → instant DB read (participant Refresh button)
// (no params) → auto-poll: always fetch from API while match is live, return DB data
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS })

  const url = new URL(req.url)
  const isParticipantRefresh =
    url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "true"

  if (isParticipantRefresh) {
    const [players, teams] = await Promise.all([readPlayersFromDb(id), readTeamsFromDb(id)])
    return NextResponse.json({ players, teams }, { headers: NO_CACHE_HEADERS })
  }

  // Auto-poll: ALWAYS fetch from external APIs during live (no staleness
  // throttle).  Previous behaviour was to skip the fetch when DB had been
  // updated in the last 45s, but that caused lockouts during the 2026-04-20
  // live match when admin POST kept `last_updated` warm while auto-poll
  // silently returned the SAME snapshot over and over.  Client polls every
  // 60s so load is bounded.
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("status, cricketdata_match_id")
    .eq("id", id)
    .single()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const debug: Record<string, any> = {
    matchStatus: match?.status ?? null,
    hasCricketdataId: !!match?.cricketdata_match_id,
    fetchAttempted: false,
    fetchResult: null,
    fetchError: null,
  }

  if (match?.status === "live" && match?.cricketdata_match_id) {
    debug.fetchAttempted = true
    try {
      const r = await fetchAndSaveScores(id, match.cricketdata_match_id)
      debug.fetchResult = {
        updated: r.updated,
        total: r.total,
        liveInProgress: r.liveInProgress ?? false,
        notStarted: r.notStarted ?? false,
        source: r.source ?? null,
      }
      if (r.lastDetail) debug.lastDetail = r.lastDetail.slice(0, 500)
    } catch (e) {
      debug.fetchError = String(e).replace(/^Error:\s*/, "").slice(0, 400)
    }
  }

  const [players, teams] = await Promise.all([readPlayersFromDb(id), readTeamsFromDb(id)])

  // Diagnostic: top-3 player rows by fantasy_points so we can see at a glance
  // whether the writes are landing with non-zero values.  When users report
  // "all scores zero", this pins down whether the calculator is returning
  // zeros (data issue) or whether the writes are being clobbered (write
  // issue) — without needing them to run SQL in Supabase.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top3 = (players as any[])
    .slice() // don't mutate the readPlayersFromDb result
    .sort((a, b) => (b.fantasy_points ?? 0) - (a.fantasy_points ?? 0))
    .slice(0, 3)
    .map(p => `${p.name}:${p.fantasy_points ?? 0}`)
    .join(", ")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonZeroCount = (players as any[]).filter(p => (p.fantasy_points ?? 0) > 0).length
  debug.top3 = top3
  debug.nonZeroPlayers = `${nonZeroCount}/${players.length}`

  return NextResponse.json({ players, teams, _debug: debug }, { headers: NO_CACHE_HEADERS })
}
