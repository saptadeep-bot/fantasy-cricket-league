/**
 * Shared scorecard-fetching helpers.
 *
 * Used by both `/finalize` and `/refinalize` so the two endpoints can't drift
 * and leave one of them vulnerable to the partial-cricapi bug we hit on
 * 2026-04-18 (finalize ran on incomplete data while Cricbuzz quota was out).
 *
 * The live-poll path in `/scores/route.ts` has its own inline copies of these
 * helpers.  Kept separate deliberately: it has extra live-specific branches
 * (liveInProgress, notStarted, currentMatches retry) that finalize doesn't
 * need, and the live path is hot & proven — not worth the refactor risk.
 *
 * Source preference:
 *   1. cricapi `match_scorecard` — richest format, contains batsman/bowler
 *      objects with nested IDs, uses plain run/ball field names that match
 *      calculateFantasyPoints() directly.  Best when fantasyEnabled:true.
 *   2. EntitySport `/matches/{id}/info` — full raw scorecard under
 *      `response.scorecard.innings[]`.  We convert field names to the
 *      cricapi shape so `calculateFantasyPoints()` can consume it uniformly.
 *
 * The final source (Cricbuzz /scard) is NOT included here.  That host's
 * monthly quota has been exhausted for this subscription tier — scores/route
 * keeps it only as a "free attempt" for the live path.  For finalize, where
 * we want bulletproof data, we skip it.
 */

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!
const CRICBUZZ_API_KEY = process.env.CRICBUZZ_API_KEY // used for EntitySport host too

// ─── cricapi ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractScorecard(data: any): unknown[] | null {
  if (!data) return null
  if (Array.isArray(data.data?.scorecard) && data.data.scorecard.length > 0) return data.data.scorecard
  if (Array.isArray(data.data) && data.data.length > 0 && data.data[0]?.batting) return data.data
  if (data.data?.batting || data.data?.bowling) return [data.data]
  return null
}

export async function fetchCricapiScorecard(cricketdataMatchId: string): Promise<unknown[] | null> {
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

/**
 * Cheap check — does cricapi think this match has ended?  Used as a soft
 * signal: if `matchEnded:false` AND we just pulled a thin scorecard, we should
 * prefer EntitySport over cricapi because cricapi may still be populating.
 */
export async function isCricapiMatchEnded(cricketdataMatchId: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_info?apikey=${CRICKETDATA_API_KEY}&id=${cricketdataMatchId}`,
      { cache: "no-store" }
    )
    const data = await res.json()
    if (data.status !== "success") return null
    return !!data.data?.matchEnded
  } catch {
    return null
  }
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

    // Search a 3-day window (today + previous two) so finalize can find
    // matches that ended late last night IST.
    const now = Date.now()
    const dates = [0, -1, -2].map(d =>
      new Date(now + d * 86_400_000).toISOString().slice(0, 10)
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allMatches: any[] = []
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
