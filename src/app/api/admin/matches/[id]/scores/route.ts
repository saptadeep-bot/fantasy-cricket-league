import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { computeAndSave, namesMatch } from "@/lib/match-scoring"
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

// ─── Scorecard fetch helpers ──────────────────────────────────────────────────

interface ScorecardResult {
  scorecard: unknown[] | null
  detail: string
  liveInProgress?: boolean
  notStarted?: boolean
}

/** Extract scorecard array from any cricapi response shape */
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

async function tryScorecard(id: string): Promise<ScorecardResult> {
  // ── Attempt 1: match_scorecard endpoint ──────────────────────────────────
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${id}`,
      { cache: "no-store" }
    )
    const data = await res.json()

    if (data.status === "success") {
      const sc = extractScorecard(data)
      if (sc) return { scorecard: sc, detail: "match_scorecard ok" }
      const dataKeys = data.data ? Object.keys(data.data).join(",") : "null"
      return { scorecard: null, detail: `match_scorecard empty (keys: ${dataKeys})` }
    }
  } catch {
    // fall through
  }

  // ── Attempt 2: match_info (check match state, sometimes has data) ─────────
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_info?apikey=${CRICKETDATA_API_KEY}&id=${id}`,
      { cache: "no-store" }
    )
    const data = await res.json()

    if (data.status === "success") {
      const matchData = data.data

      // Use truthy/falsy — cricapi returns these as booleans, strings, or numbers
      const started = matchData?.matchStarted
      const ended = matchData?.matchEnded

      if (started && !ended) {
        // Match is live — scorecard not yet available mid-innings via this API
        return {
          scorecard: null,
          detail: `live_in_progress (fantasyEnabled:${matchData.fantasyEnabled}, bbbEnabled:${matchData.bbbEnabled}, matchStarted:${started}, matchEnded:${ended})`,
          liveInProgress: true,
        }
      }

      if (!started) {
        return {
          scorecard: null,
          detail: `match_not_started (matchStarted:${started})`,
          notStarted: true,
        }
      }

      // started && ended — match complete but scorecard unavailable
      const sc = extractScorecard(data)
      if (sc) return { scorecard: sc, detail: "match_info ok" }

      const dataKeys = matchData ? Object.keys(matchData).join(",") : "null"
      return { scorecard: null, detail: `match_info empty (matchStarted:${started}, matchEnded:${ended}, keys: ${dataKeys})` }
    }
    return { scorecard: null, detail: `match_info failed: ${data.reason || data.message || data.status}` }
  } catch (e) {
    return { scorecard: null, detail: `network error: ${String(e)}` }
  }
}

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

// Count batters + bowlers across all innings in a converted scorecard.  Used
// to pick the richer source when both cricapi and EntitySport return data.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countScorecardPlayers(scorecard: any[]): number {
  let n = 0
  for (const inn of scorecard || []) {
    n += (inn.batting?.length ?? 0)
    n += (inn.bowling?.length ?? 0)
  }
  return n
}

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

// ─── Cricbuzz fallback helpers ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertCricbuzzScorecard(scoreCard: any[]): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return scoreCard.map((innings: any) => {
    // Handle both old (batTeamDetails) and new (batteamname) structures
    const batTeamName: string =
      innings.batteamname ?? innings.batTeamDetails?.batTeamName ?? "Unknown"
    const inningsId: number = innings.inningsid ?? innings.inningsId ?? 1

    // ── Batting ──────────────────────────────────────────────────────────────
    // Batsmen: might be at innings.batsman (array/object) or innings.batTeamDetails.batsmenData (object)
    const batsmenRaw = innings.batsman ?? innings.batTeamDetails?.batsmenData ?? {}
    const batsmenList: unknown[] = Array.isArray(batsmenRaw)
      ? batsmenRaw
      : (batsmenRaw && typeof batsmenRaw === "object")
        ? Object.values(batsmenRaw)
        : []

    const batting = batsmenList
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((bat: any) => {
        const id = bat.batsman_id ?? bat.batId ?? bat.id ?? bat.player_id
        const name = bat.bat_name ?? bat.batName ?? bat.name
        return id && name
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((bat: any) => ({
        id: "cb_" + (bat.batsman_id ?? bat.batId ?? bat.id ?? bat.player_id),
        name: bat.bat_name ?? bat.batName ?? bat.name,
        r: Number(bat.bat_runs ?? bat.r ?? bat.runs ?? 0),
        b: Number(bat.bat_balls ?? bat.b ?? bat.balls ?? 0),
        "4s": Number(bat.bat_fours ?? bat["4s"] ?? bat.fours ?? 0),
        "6s": Number(bat.bat_sixes ?? bat["6s"] ?? bat.sixes ?? 0),
        dismissal: bat.out_desc ?? bat["dismissal-text"] ?? bat.dismissal ?? bat.outDesc ?? "",
      }))

    // ── Bowling ──────────────────────────────────────────────────────────────
    const bowlersRaw = innings.bowler ?? innings.bowlTeamDetails?.bowlersData ?? {}
    const bowlersList: unknown[] = Array.isArray(bowlersRaw)
      ? bowlersRaw
      : Object.values(bowlersRaw)

    const bowling = bowlersList
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((bowl: any) => {
        const id = bowl.bowler_id ?? bowl.bowlId ?? bowl.id ?? bowl.player_id
        const name = bowl.bowl_name ?? bowl.bowlName ?? bowl.name
        return id && name
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((bowl: any) => ({
        id: "cb_" + (bowl.bowler_id ?? bowl.bowlId ?? bowl.id ?? bowl.player_id),
        name: bowl.bowl_name ?? bowl.bowlName ?? bowl.name,
        o: bowl.bowl_overs ?? bowl.o ?? bowl.overs ?? 0,
        m: Number(bowl.bowl_maidens ?? bowl.m ?? bowl.maidens ?? 0),
        r: Number(bowl.bowl_runs ?? bowl.r ?? bowl.runs ?? 0),
        w: Number(bowl.bowl_wickets ?? bowl.w ?? bowl.wickets ?? 0),
        nb: Number(bowl.bowl_noballs ?? bowl.nb ?? bowl.noBalls ?? 0),
        wd: Number(bowl.bowl_wides ?? bowl.wd ?? bowl.wides ?? 0),
      }))

    // ── Fielding ─────────────────────────────────────────────────────────────
    // Try to extract fielding from fow (fall of wickets) if available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fowRaw = innings.fow ?? innings.wicketsData ?? {}
    const fowList: unknown[] = Array.isArray(fowRaw) ? fowRaw : Object.values(fowRaw)
    const fielderMap = new Map<string, { id: string; name: string; catch: number; stumped: number; runout: number; cb: number }>()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const wicket of fowList) {
      const w = wicket as any
      // Try Cricbuzz fow structure: might have fielder info
      const fielderId = w.fielder_id ?? w.fielderId1 ?? w.fielder?.id
      const fielderName = w.fielder_name ?? w.fielderName1 ?? w.fielder?.name
      const wicketCode: string = (w.wicket_code ?? w.wicketCode ?? w.dismissal_type ?? "").toUpperCase()
      if (!fielderId || !fielderName) continue
      const fid = "cb_" + fielderId
      if (!fielderMap.has(fid)) {
        fielderMap.set(fid, { id: fid, name: fielderName, catch: 0, stumped: 0, runout: 0, cb: 0 })
      }
      const entry = fielderMap.get(fid)!
      if (wicketCode.includes("CAUGHT AND BOWLED")) entry.cb++
      else if (wicketCode.includes("CAUGHT")) entry.catch++
      else if (wicketCode.includes("STUMPED")) entry.stumped++
      else if (wicketCode.includes("RUN OUT")) entry.runout++
    }
    const catching = Array.from(fielderMap.values())

    return {
      inning: `${batTeamName} Inning ${inningsId}`,
      batting,
      bowling,
      catching,
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenCricbuzzMatches(data: any): any[] {
  const allMatches: any[] = []
  for (const typeMatch of (data.typeMatches ?? [])) {
    for (const seriesMatch of (typeMatch.seriesMatches ?? [])) {
      // Matches can live under seriesAdWrapper.matches (common), directly on
      // seriesMatch.matches, or even as adWrapper fields. Collect from all.
      const candidates = [
        seriesMatch.seriesAdWrapper?.matches,
        seriesMatch.matches,
        seriesMatch.adWrapper?.matches,
      ]
      for (const list of candidates) {
        if (Array.isArray(list)) allMatches.push(...list)
      }
    }
  }
  return allMatches
}

async function tryCricbuzzScorecard(team1: string, team2: string, apiKey: string): Promise<unknown[] | null> {
  try {
    const cbHeaders = {
      "X-RapidAPI-Key": apiKey,
      "X-RapidAPI-Host": "cricbuzz-cricket.p.rapidapi.com",
    }

    const tokens = (name: string): string[] => {
      const parts = name.toLowerCase().split(/\s+/).filter(Boolean)
      const toks = new Set<string>([name.toLowerCase(), ...parts])
      // Acronym from initials: "Royal Challengers Bangalore" → "rcb"
      if (parts.length >= 2) toks.add(parts.map(p => p[0]).join(""))
      return Array.from(toks).filter(t => t.length >= 2)
    }
    const t1 = tokens(team1)
    const t2 = tokens(team2)
    const hits = (haystack: string, toks: string[]) =>
      toks.some(t => haystack.toLowerCase().includes(t))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findInList = (allMatches: any[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      allMatches.find((m: any) => {
        const mi = m.matchInfo
        if (!mi) return false
        const haystack = [
          mi.team1?.teamName ?? "",
          mi.team1?.teamSName ?? "",
          mi.team2?.teamName ?? "",
          mi.team2?.teamSName ?? "",
        ].join(" ")
        return hits(haystack, t1) && hits(haystack, t2)
      })

    // Try live matches first, then recent (for completed matches)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let found: any = null
    for (const endpoint of ["live", "recent"]) {
      try {
        const res = await fetch(`https://cricbuzz-cricket.p.rapidapi.com/matches/v1/${endpoint}`, {
          headers: cbHeaders,
          cache: "no-store",
        })
        if (!res.ok) continue
        const data = await res.json()
        found = findInList(flattenCricbuzzMatches(data))
        if (found) break
      } catch { continue }
    }

    if (!found) return null

    const cbMatchId: number = found.matchInfo.matchId
    const scRes = await fetch(`https://cricbuzz-cricket.p.rapidapi.com/mcenter/v1/${cbMatchId}/scard`, {
      headers: cbHeaders,
      cache: "no-store",
    })
    if (!scRes.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scData: any = await scRes.json()

    // Cricbuzz returns "scorecard" (lowercase), not "scoreCard"
    const scArray = scData.scoreCard ?? scData.scorecard
    if (!Array.isArray(scArray) || scArray.length === 0) return null

    return convertCricbuzzScorecard(scArray)
  } catch {
    return null
  }
}

// ─── EntitySport scorecard helpers ────────────────────────────────────────────
// EntitySport's /matches/{id}/info returns a full raw scorecard with batting,
// bowling, and fielding arrays.  This is the PRIMARY fallback when cricapi's
// match_scorecard is empty (fantasyEnabled:false mid-innings) and Cricbuzz is
// unavailable (quota exhausted).  Its data is Dream11-compatible because we
// feed raw stats into our own calculateFantasyPoints — we do NOT use
// EntitySport's pre-computed `point` field (different formula).

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

    // EntitySport gives a dedicated fielder array — more reliable than parsing
    // dismissal text.  Fields: catches, runout_thrower, runout_catcher,
    // runout_direct_hit, stumping.  Dream11 credits runouts once per dismissal,
    // so we count direct hits + (thrower+catcher sum, which together equal one
    // runout).  For safety we pick max(thrower, catcher) to avoid double
    // counting when both IDs point to the same runout.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catching = (inn.fielder ?? []).map((f: any) => {
      const catches = Number(f.catches ?? 0)
      const stumped = Number(f.stumping ?? 0)
      const thrower = Number(f.runout_thrower ?? 0)
      const catcher = Number(f.runout_catcher ?? 0)
      const direct = Number(f.runout_direct_hit ?? 0)
      const runouts = direct + Math.max(thrower, catcher)
      return {
        id: "es_" + (f.fielder_id ?? ""),
        name: f.fielder_name ?? "",
        catch: catches,
        stumped,
        runout: runouts,
        cb: 0,
      }
    })

    return {
      inning: `${battingTeam} ${inningsId}`,
      batting,
      bowling,
      catching,
    }
  })
}

async function tryEntitySportInfo(team1: string, team2: string, apiKey: string): Promise<unknown[] | null> {
  try {
    const headers = {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }

    // Step A: find the EntitySport match_id that matches our team names.
    //
    // We AGGREGATE across multiple listing endpoints (don't break on first
    // non-empty!). On 2026-04-19 live refresh was flaky because
    // `/matches?date=today` would return today's matches *without* the
    // currently-live one sometimes (their cache lags), we'd break out with a
    // non-empty list, fail to find our match, and return null.  Merging across
    // date/status/default endpoints + ±1 day window makes the lookup
    // deterministic instead of dependent on which endpoint responded first.
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
      try {
        const r = await fetch(url, { headers, cache: "no-store" })
        if (!r.ok) continue
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

    // Step B: fetch full info with scorecard
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

    // Sanity: if conversion yielded no actual player entries, treat as not-found
    // so callers fall through to other sources.
    const hasPlayers = converted.some((inn: unknown) => {
      const i = inn as { batting?: unknown[]; bowling?: unknown[] }
      return (i.batting?.length ?? 0) > 0 || (i.bowling?.length ?? 0) > 0
    })
    if (!hasPlayers) return null

    return converted
  } catch {
    return null
  }
}

async function tryEntitySportDirect(matchId: string, team1: string, team2: string, apiKey: string): Promise<FetchResult | null> {
  try {
    const headers = {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }

    // Find the match — try live first, then completed (status=3), then scheduled
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allMatches: any[] = []
    for (const url of [
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=2",   // live
      "https://cricket-live-line-advance.p.rapidapi.com/livematches",
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=3",   // completed
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=live",
      "https://cricket-live-line-advance.p.rapidapi.com/matches?status=1",   // scheduled (fallback)
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

    // Build token sets for each team (first word, last word, full name) — any
    // token hit counts.  Handles "Royal Challengers Bangalore" → matches feed
    // listing it as "RCB", "Bangalore", "Challengers", or "Royal".
    const tokens = (name: string): string[] => {
      const parts = name.toLowerCase().split(/\s+/).filter(Boolean)
      const toks = new Set<string>([name.toLowerCase(), ...parts])
      // Acronym from initials, e.g. "Royal Challengers Bangalore" → "rcb"
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

    // Load existing DB players for name matching
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

async function fetchAndSaveScores(matchId: string, cricketdataMatchId: string): Promise<FetchResult> {
  // Fetch team names once upfront — used by Steps 2, 3, 4
  const { data: matchRow } = await supabaseAdmin
    .from("matches")
    .select("team1, team2")
    .eq("id", matchId)
    .single()
  const team1 = matchRow?.team1 ?? ""
  const team2 = matchRow?.team2 ?? ""

  // Step 1: try the stored ID
  const r1 = await tryScorecard(cricketdataMatchId)
  let scorecard = r1.scorecard
  let source = scorecard ? "cricapi" : ""
  let lastDetail = `stored ID (${cricketdataMatchId}): ${r1.detail}`
  let liveInProgress = r1.liveInProgress ?? false
  let notStarted = r1.notStarted ?? false

  // Step 2: if no scorecard and not definitively live/unstarted, search currentMatches
  if (!scorecard && !liveInProgress && !notStarted) {
    if (team1 && team2) {
      const foundId = await findLiveMatchId(team1, team2)
      lastDetail += ` | currentMatches lookup: ${foundId ?? "not found"}`

      if (foundId) {
        if (foundId !== cricketdataMatchId) {
          await supabaseAdmin
            .from("matches")
            .update({ cricketdata_match_id: foundId })
            .eq("id", matchId)
        }
        const r2 = await tryScorecard(foundId)
        scorecard = r2.scorecard
        if (scorecard) source = "cricapi-remap"
        liveInProgress = r2.liveInProgress ?? false
        notStarted = r2.notStarted ?? false
        lastDetail += ` | retry (${foundId}): ${r2.detail}`
      }
    }
  }

  // Step 3a: EntitySport /info — PRIMARY live fallback.
  //
  // We also run this when cricapi gave us a THIN scorecard (<15 batter+bowler
  // entries across both innings).  Reason: mid-match cricapi sometimes flips
  // fantasyEnabled:true but populates the scorecard player-by-player — so
  // we'd lock onto a partial 10-player view and never see the full picture
  // even as the match progressed.  That was the 2026-04-21 live-refresh bug.
  // EntitySport's /matches/{id}/info returns a full raw scorecard (batting
  // runs/balls/4s/6s, bowling overs/maidens/wickets, fielding
  // catches/stumpings/runouts) which we feed into calculateFantasyPoints.
  const cricapiCount = scorecard ? countScorecardPlayers(scorecard) : 0
  const shouldTryEntitySport = (!scorecard || cricapiCount < 15) && !notStarted && CRICBUZZ_API_KEY && team1 && team2
  if (shouldTryEntitySport) {
    const esSc = await tryEntitySportInfo(team1, team2, CRICBUZZ_API_KEY!)
    const esCount = esSc ? countScorecardPlayers(esSc) : 0
    if (esSc && esCount > cricapiCount) {
      // EntitySport has more players — use it
      scorecard = esSc
      source = `entitysport-info (es ${esCount} vs cricapi ${cricapiCount})`
      liveInProgress = false
      lastDetail += ` | entitysport-info: ok (${esCount} players, richer than cricapi ${cricapiCount})`
    } else if (esSc) {
      lastDetail += ` | entitysport-info: ${esCount} players (cricapi ${cricapiCount} already richer, keeping cricapi)`
    } else if (scorecard) {
      lastDetail += ` | entitysport-info: not found (keeping thin cricapi ${cricapiCount})`
    } else {
      lastDetail += " | entitysport-info: not found"
    }
  }

  // Step 3b: Cricbuzz fallback — secondary, used when EntitySport /info can't
  // find the match.  Currently on a BASIC plan so quota may be exhausted; still
  // worth a try since it's free to attempt.
  if (!scorecard && !notStarted && CRICBUZZ_API_KEY) {
    if (team1 && team2) {
      const cbSc = await tryCricbuzzScorecard(team1, team2, CRICBUZZ_API_KEY)
      if (cbSc) {
        scorecard = cbSc
        source = "cricbuzz"
        liveInProgress = false
        lastDetail += " | cricbuzz: ok"
      } else {
        lastDetail += " | cricbuzz: not found"
      }
    }
  }

  // Step 4: EntitySport — FINAL FALLBACK only, used when Steps 1-3 gave us no
  // scorecard at all.  EntitySport's newpoint2 uses its own scoring formula
  // which does NOT match our Dream11-style points (e.g. wickets worth 25 pts),
  // so we must NOT let it override a correct scorecard computation.  Its only
  // job is to provide *some* points when every other source is empty.
  if (!scorecard && !notStarted && CRICBUZZ_API_KEY && team1 && team2) {
    const esResult = await tryEntitySportDirect(matchId, team1, team2, CRICBUZZ_API_KEY)
    if (esResult) {
      lastDetail += ` | entitysport fallback: ${esResult.updated}/${esResult.total}`
      return { ...esResult, source: "entitysport-newpoint2", lastDetail }
    }
    lastDetail += " | entitysport: not found"
  }

  // Primary path: compute Dream11 points from the raw scorecard
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
  const { data } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name, team, role, fantasy_points, last_updated")
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
      return NextResponse.json({
        success: false,
        liveInProgress: true,
        error: "Match is currently live — scores are refreshing automatically every 60 seconds. If points aren't showing yet, they'll appear shortly.",
        players,
      }, { headers: NO_CACHE_HEADERS })
    }

    if (result.notStarted) {
      const players = await readPlayersFromDb(id)
      return NextResponse.json({
        success: false,
        notStarted: true,
        error: "Match hasn't started yet. Scores will be available once the match begins.",
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
// (no params) → auto-poll: fetch from API if stale, return DB data
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
  // silently returned the SAME snapshot over and over.  The client polls
  // every 60s so the load is bounded and external quotas are unaffected.
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
  return NextResponse.json({ players, teams, _debug: debug }, { headers: NO_CACHE_HEADERS })
}
