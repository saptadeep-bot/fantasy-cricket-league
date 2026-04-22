/**
 * Shared scorecard-fetching helpers — the single source of truth for every
 * path that needs a scorecard (live auto-poll, admin Refresh, finalize,
 * refinalize).
 *
 * Before 2026-04-22 the live-poll path in `/scores/route.ts` kept its own
 * inline copies of these helpers.  The duplicates drifted twice in the span
 * of a week (once for ±1-day date windows, once for listing aggregation) and
 * the live path broke while finalize was still fine.  On 2026-04-22 we
 * consolidated: there is now ONE set of helpers here.  The live path wraps
 * `fetchBestScorecardLive()` (which layers match-state detection on top of
 * `fetchBestScorecard`) and retains only its truly live-specific extras
 * (cricapi ID remap via `currentMatches`, and the `newpoint2` last-resort).
 *
 * Source preference:
 *   1. cricapi `match_scorecard` — richest format, contains batsman/bowler
 *      objects with nested IDs, uses plain run/ball field names that match
 *      calculateFantasyPoints() directly.  Best when fantasyEnabled:true.
 *   2. EntitySport `/matches/{id}/info` — full raw scorecard under
 *      `response.scorecard.innings[]`.  We convert field names to the
 *      cricapi shape so `calculateFantasyPoints()` can consume it uniformly.
 *
 * Both sources are ALWAYS fetched in parallel — whichever returned more
 * batter+bowler entries wins.  This defends against partial cricapi data
 * during the window where `fantasyEnabled` has flipped to true but the
 * scorecard is still populating player-by-player (the 2026-04-21 bug).
 *
 * Cricbuzz `/scard` is NOT included here.  That host's monthly quota has
 * been exhausted for this subscription tier — the live route keeps it only
 * as a "free attempt" fallback.  For finalize, where we want bulletproof
 * data, we skip it.
 */

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!
const CRICBUZZ_API_KEY = process.env.CRICBUZZ_API_KEY // same key covers EntitySport host

// ─── Timeout helper ───────────────────────────────────────────────────────────
// Every external call has a bounded timeout.  Auto-poll fires every 60s and the
// Vercel function cap is 60s, so a hanging upstream could freeze a poll cycle.
//
// NOTE on 2026-04-22: originally set to 8s.  That was too tight — EntitySport's
// `/info` endpoint regularly takes 10-15s under load, and aborting at 8s
// silently dropped us back to "no scorecard" → `live_in_progress` with nothing
// visible in the UI.  20s gives real APIs room to breathe while still being a
// hard cap on dead connections.  With 6 possible EntitySport calls (5 listings
// + 1 info), worst case is 120s — far exceeds maxDuration, but in practice
// they're never all slow at once, and a short-circuit on the first successful
// listing keeps the typical case well under 30s.
const DEFAULT_TIMEOUT_MS = 20_000

async function timedFetch(
  input: string,
  init?: RequestInit,
  ms = DEFAULT_TIMEOUT_MS
): Promise<Response | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(input, { ...init, signal: ac.signal })
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// ─── cricapi ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractScorecard(data: any): unknown[] | null {
  if (!data) return null
  if (Array.isArray(data.data?.scorecard) && data.data.scorecard.length > 0) return data.data.scorecard
  if (Array.isArray(data.data) && data.data.length > 0 && data.data[0]?.batting) return data.data
  if (data.data?.batting || data.data?.bowling) return [data.data]
  if (Array.isArray(data.data?.cards) && data.data.cards.length > 0) return data.data.cards
  if (Array.isArray(data.data?.innings) && data.data.innings.length > 0) return data.data.innings
  return null
}

export async function fetchCricapiScorecard(cricketdataMatchId: string): Promise<unknown[] | null> {
  try {
    const res = await timedFetch(
      `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${cricketdataMatchId}`,
      { cache: "no-store" }
    )
    if (!res) return null
    const data = await res.json()
    if (data.status !== "success") return null
    return extractScorecard(data)
  } catch {
    return null
  }
}

export interface CricapiMatchInfo {
  matchStarted: boolean
  matchEnded: boolean
  fantasyEnabled: boolean
  bbbEnabled: boolean
}

/**
 * Fetch cricapi match_info and return the flags the live-poll path cares
 * about (started / ended / fantasyEnabled).  Returns null on any failure so
 * callers can treat state as unknown.
 */
export async function fetchCricapiMatchInfo(cricketdataMatchId: string): Promise<CricapiMatchInfo | null> {
  try {
    const res = await timedFetch(
      `https://api.cricapi.com/v1/match_info?apikey=${CRICKETDATA_API_KEY}&id=${cricketdataMatchId}`,
      { cache: "no-store" }
    )
    if (!res) return null
    const data = await res.json()
    if (data.status !== "success") return null
    const d = data.data ?? {}
    return {
      matchStarted: !!d.matchStarted,
      matchEnded: !!d.matchEnded,
      fantasyEnabled: !!d.fantasyEnabled,
      bbbEnabled: !!d.bbbEnabled,
    }
  } catch {
    return null
  }
}

/**
 * Back-compat soft signal: cricapi's view of "did this match end?".  Prefer
 * `fetchCricapiMatchInfo` for new code — it also exposes matchStarted.
 */
export async function isCricapiMatchEnded(cricketdataMatchId: string): Promise<boolean | null> {
  const info = await fetchCricapiMatchInfo(cricketdataMatchId)
  return info ? info.matchEnded : null
}

// ─── EntitySport ──────────────────────────────────────────────────────────────

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

    // EntitySport gives a dedicated fielder array per innings — more reliable
    // than parsing dismissal strings.  Fields: catches, stumping,
    // runout_thrower, runout_catcher, runout_direct_hit.
    // Dream11 credits one runout per dismissal, so we take
    // direct + max(thrower, catcher) to avoid double-counting when both IDs
    // point to the same runout event.
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

export async function fetchEntitySportScorecard(team1: string, team2: string): Promise<unknown[] | null> {
  if (!CRICBUZZ_API_KEY) return null
  if (!team1 || !team2) return null

  try {
    const headers = {
      "x-rapidapi-key": CRICBUZZ_API_KEY,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }

    // Aggregate across multiple listing endpoints — don't break on first
    // non-empty!  EntitySport's caches lag at different rates across endpoints
    // (date-listing vs live-listing vs default-listing).  Missing the
    // currently-live match from one listing has bitten us before (commit
    // 7241093 re-introduced a `break` that caused flaky live refresh).
    //
    // Date window is ±1 day in UTC — covers matches that start late evening
    // IST (crosses UTC midnight) and matches that roll past UTC midnight.
    const now = Date.now()
    const dates = [0, -1, 1].map(d =>
      new Date(now + d * 86_400_000).toISOString().slice(0, 10)
    )
    const listingUrls = [
      ...dates.map(d => `https://cricket-live-line-advance.p.rapidapi.com/matches?date=${d}`),
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=live",
      "https://cricket-live-line-advance.p.rapidapi.com/matches",
    ]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allMatches: any[] = []
    const seen = new Set<string>()
    for (const url of listingUrls) {
      const r = await timedFetch(url, { headers, cache: "no-store" })
      if (!r || !r.ok) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = await r.json()
        const arr = Array.isArray(d?.response?.items) ? d.response.items
          : Array.isArray(d?.response) ? d.response
          : Array.isArray(d?.data) ? d.data
          : null
        if (!arr) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const m of arr as any[]) {
          const mid = String(m.match_id ?? m.id ?? "")
          if (!mid || seen.has(mid)) continue
          seen.add(mid)
          allMatches.push(m)
        }
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

    const infoRes = await timedFetch(
      `https://cricket-live-line-advance.p.rapidapi.com/matches/${esMatchId}/info`,
      { headers, cache: "no-store" }
    )
    if (!infoRes || !infoRes.ok) return null
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

// ─── Quality checks ───────────────────────────────────────────────────────────

/**
 * Count total batters + bowlers across all innings.  Used to compare richness
 * between cricapi and EntitySport responses when both return data — we take
 * the one with more entries, since partial cricapi data is the primary
 * failure mode.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function countScorecardPlayers(scorecard: any[]): number {
  let n = 0
  for (const inn of scorecard || []) {
    n += (inn.batting?.length ?? 0)
    n += (inn.bowling?.length ?? 0)
  }
  return n
}

/**
 * Fetch the richest scorecard available from our two most reliable sources.
 * Tries both in parallel, picks whichever has more player entries.  If either
 * is null, returns the other.  If both null, returns null.
 *
 * The `source` string is for logging/debugging (e.g. "cricapi" or
 * "entitysport-info" or "cricapi (richer)").
 *
 * Used by finalize/refinalize — they don't need match-state detection so they
 * call this directly.  Live-poll uses `fetchBestScorecardLive` which layers
 * match-state detection on top of this.
 */
export async function fetchBestScorecard(
  cricketdataMatchId: string,
  team1: string,
  team2: string
): Promise<{ scorecard: unknown[] | null; source: string }> {
  const [cricapiRes, esRes] = await Promise.all([
    fetchCricapiScorecard(cricketdataMatchId),
    fetchEntitySportScorecard(team1, team2),
  ])

  const cricapiN = cricapiRes ? countScorecardPlayers(cricapiRes as unknown[]) : 0
  const esN = esRes ? countScorecardPlayers(esRes as unknown[]) : 0

  if (!cricapiRes && !esRes) return { scorecard: null, source: "none" }
  if (!cricapiRes) return { scorecard: esRes, source: "entitysport-info" }
  if (!esRes) return { scorecard: cricapiRes, source: "cricapi" }

  // Both present — pick the richer one.  When they're within 2 players of
  // each other, prefer cricapi (native shape, more fields preserved for
  // fielding).
  if (cricapiN + 2 >= esN) return { scorecard: cricapiRes, source: `cricapi (${cricapiN} vs es ${esN})` }
  return { scorecard: esRes, source: `entitysport-info (${esN} vs cricapi ${cricapiN})` }
}

// ─── Live-aware variant ──────────────────────────────────────────────────────

export interface LiveScorecardResult {
  scorecard: unknown[] | null
  source: string
  /** True when the match is in progress AND we couldn't get any scorecard —
   * caller should show "live, waiting for scores" rather than an error. */
  liveInProgress: boolean
  /** True when the match hasn't started yet AND we have no scorecard. */
  notStarted: boolean
  /** Single-string summary of what happened across all sources.  Safe to log
   * or display — includes counts and state flags for diagnostics. */
  detail: string
}

/**
 * Live-poll entry point.  Fetches cricapi scorecard + cricapi match_info +
 * EntitySport scorecard all in parallel, picks the richer of the two
 * scorecards, and layers match-state detection (liveInProgress / notStarted)
 * on top for the case where both sources returned nothing.
 *
 * Invariant: `liveInProgress` and `notStarted` are only true when `scorecard`
 * is null.  If we have any scorecard, we return it and leave those flags
 * false — the caller will display the scores.
 */
export async function fetchBestScorecardLive(
  cricketdataMatchId: string,
  team1: string,
  team2: string
): Promise<LiveScorecardResult> {
  const [cricapiSc, cricapiInfo, esSc] = await Promise.all([
    fetchCricapiScorecard(cricketdataMatchId),
    fetchCricapiMatchInfo(cricketdataMatchId),
    fetchEntitySportScorecard(team1, team2),
  ])

  const cricapiN = cricapiSc ? countScorecardPlayers(cricapiSc as unknown[]) : 0
  const esN = esSc ? countScorecardPlayers(esSc as unknown[]) : 0

  let scorecard: unknown[] | null = null
  let source = "none"
  if (cricapiSc && esSc) {
    // Both present — pick richer.  Tie / within-2 goes to cricapi (native
    // shape, better fielding data).
    if (cricapiN + 2 >= esN) {
      scorecard = cricapiSc
      source = `cricapi (${cricapiN} vs es ${esN})`
    } else {
      scorecard = esSc
      source = `entitysport-info (es ${esN} vs cricapi ${cricapiN})`
    }
  } else if (cricapiSc) {
    scorecard = cricapiSc
    source = `cricapi (${cricapiN})`
  } else if (esSc) {
    scorecard = esSc
    source = `entitysport-info (${esN})`
  }

  const liveInProgress = !scorecard && !!cricapiInfo && cricapiInfo.matchStarted && !cricapiInfo.matchEnded
  const notStarted = !scorecard && !!cricapiInfo && !cricapiInfo.matchStarted

  const infoStr = cricapiInfo
    ? `info:started=${cricapiInfo.matchStarted},ended=${cricapiInfo.matchEnded},fantasy=${cricapiInfo.fantasyEnabled}`
    : "info:unavailable"
  const detail = `cricapi:${cricapiN} | es:${esN} | ${infoStr} | source:${source}`

  return { scorecard, source, liveInProgress, notStarted, detail }
}
