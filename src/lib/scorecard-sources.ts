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

/**
 * Detailed variant — returns both the scorecard (or null) and a short human-
 * readable `reason` string explaining the outcome.  The reason is threaded
 * into `fetchBestScorecardLive`'s detail string so we can diagnose WHY
 * EntitySport returned nothing without needing to tail Vercel logs.
 *
 * Reason categories:
 *   - `no_api_key` / `no_teams` — configuration
 *   - `no_listings` — every listing URL returned empty / failed
 *   - `listed_N_no_team_match (sample: ...)` — N matches found in listings,
 *     but no haystack contained both team tokens.  Sample gives the first
 *     haystack so we can eyeball the naming mismatch.
 *   - `matched_<id>_info_http_error` — found the match, /info endpoint failed
 *   - `matched_<id>_no_innings` — found the match, /info returned no innings
 *     (normal before ball 1; seeing this mid-match means EntitySport lagged)
 *   - `matched_<id>_empty_players` — innings present but no batters/bowlers
 *   - `ok_<count>` — success
 *   - `error: <msg>` — exception path
 */
// ─── EntitySport listing resolver (shared) ───────────────────────────────────
// Given our stored team1/team2 names, find the corresponding EntitySport
// match_id by aggregating multiple listing endpoints and tokenising team names.
// Used by BOTH the scorecard fetcher AND the squad fetcher — don't inline a
// second copy here (it drifted once already, commit fdaf8fe).
export async function resolveEntitySportMatchId(
  team1: string,
  team2: string,
): Promise<{ esMatchId: string | null; reason: string }> {
  if (!CRICBUZZ_API_KEY) return { esMatchId: null, reason: "no_api_key" }
  if (!team1 || !team2) return { esMatchId: null, reason: "no_teams" }

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
  const statuses: string[] = []
  for (const url of listingUrls) {
    const r = await timedFetch(url, { headers, cache: "no-store" })
    if (!r) { statuses.push("TO"); continue }
    if (!r.ok) { statuses.push(String(r.status)); continue }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = await r.json()
      const arr = Array.isArray(d?.response?.items) ? d.response.items
        : Array.isArray(d?.response) ? d.response
        : Array.isArray(d?.data) ? d.data
        : null
      if (!arr) { statuses.push("200-noarr"); continue }
      statuses.push(`200-${arr.length}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const m of arr as any[]) {
        const mid = String(m.match_id ?? m.id ?? "")
        if (!mid || seen.has(mid)) continue
        seen.add(mid)
        allMatches.push(m)
      }
    } catch { statuses.push("json-err") }
  }
  if (allMatches.length === 0) {
    return { esMatchId: null, reason: `no_listings [${statuses.join(",")}]` }
  }

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
  const buildHaystack = (m: any) => [
    m.title ?? "", m.short_title ?? "",
    m.teama?.name ?? "", m.teama?.short_name ?? "",
    m.teamb?.name ?? "", m.teamb?.short_name ?? "",
  ].join(" ").toLowerCase()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = allMatches.find((m: any) => {
    const haystack = buildHaystack(m)
    return hits(haystack, t1) && hits(haystack, t2)
  })
  if (!found) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sample = allMatches.slice(0, 3).map((m: any) => m.short_title ?? m.title ?? "?").join("; ")
    return {
      esMatchId: null,
      reason: `listed_${allMatches.length}_no_team_match (t1=${t1.join(",")};t2=${t2.join(",")};sample=${sample})`,
    }
  }

  const esMatchId = found.match_id ?? found.id
  if (!esMatchId) return { esMatchId: null, reason: "matched_but_no_id" }
  return { esMatchId: String(esMatchId), reason: `ok_found_${esMatchId}` }
}

export async function fetchEntitySportScorecardDetailed(
  team1: string,
  team2: string
): Promise<{ scorecard: unknown[] | null; reason: string }> {
  const resolved = await resolveEntitySportMatchId(team1, team2)
  if (!resolved.esMatchId) return { scorecard: null, reason: resolved.reason }
  const esMatchId = resolved.esMatchId

  try {
    const headers = {
      "x-rapidapi-key": CRICBUZZ_API_KEY!,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }
    const infoRes = await timedFetch(
      `https://cricket-live-line-advance.p.rapidapi.com/matches/${esMatchId}/info`,
      { headers, cache: "no-store" }
    )
    if (!infoRes || !infoRes.ok) {
      const code = infoRes ? infoRes.status : "timeout"
      return { scorecard: null, reason: `matched_${esMatchId}_info_http_${code}` }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const infoData: any = await infoRes.json()

    const innings = infoData?.response?.scorecard?.innings
    if (!Array.isArray(innings) || innings.length === 0) {
      return { scorecard: null, reason: `matched_${esMatchId}_no_innings` }
    }

    const converted = convertEntitySportScorecard(innings)
    const playerCount = converted.reduce((sum: number, inn: unknown) => {
      const i = inn as { batting?: unknown[]; bowling?: unknown[] }
      return sum + (i.batting?.length ?? 0) + (i.bowling?.length ?? 0)
    }, 0)
    if (playerCount === 0) {
      return { scorecard: null, reason: `matched_${esMatchId}_empty_players` }
    }
    return { scorecard: converted, reason: `ok_${playerCount}` }
  } catch (e) {
    return { scorecard: null, reason: `error:${String(e).slice(0, 60)}` }
  }
}

// ─── EntitySport squad fetcher ───────────────────────────────────────────────
// Pulls the full squad (including impact substitutes) from EntitySport's
// `/matches/{id}/info` response.  Cricapi's `/match_squad` regularly misses
// named impact-sub-pool players (e.g. G Linde vs LSG on 2026-04-22) — this
// is our primary way of catching them.
//
// Shape of the useful bit of the `/info` response:
//   response.squads.teama.squads[] = [{ player_id, name, role, playing11, substitute }, ...]
//   response.squads.teamb.squads[] = same
//   response.teama.name / response.teamb.name = full team name
//
// We map EntitySport roles to our 4-bucket scheme (BAT/BOWL/ALL/WK) and
// return each player tagged with its team name.  IDs come through as raw
// EntitySport `player_id` strings — the caller is responsible for deciding
// how to merge them with cricapi IDs (usually: name-match, prefer cricapi).

export interface EntitySportSquadPlayer {
  es_player_id: string
  name: string
  team: string
  role: "BAT" | "BOWL" | "ALL" | "WK"
  es_substitute: boolean   // true if EntitySport tagged them as impact-sub
  es_playing11: boolean    // true if EntitySport tagged them as in announced XI
}

function mapEntitySportRole(role: string): "BAT" | "BOWL" | "ALL" | "WK" {
  const r = (role || "").toLowerCase()
  if (r.includes("wk") || r.includes("wicket")) return "WK"
  if (r.includes("all")) return "ALL"
  if (r.includes("bowl")) return "BOWL"
  if (r.includes("bat")) return "BAT"
  return "BAT"
}

export async function fetchEntitySportSquadDetailed(
  team1: string,
  team2: string,
): Promise<{ players: EntitySportSquadPlayer[] | null; reason: string }> {
  const resolved = await resolveEntitySportMatchId(team1, team2)
  if (!resolved.esMatchId) return { players: null, reason: resolved.reason }
  const esMatchId = resolved.esMatchId

  try {
    const headers = {
      "x-rapidapi-key": CRICBUZZ_API_KEY!,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }
    const infoRes = await timedFetch(
      `https://cricket-live-line-advance.p.rapidapi.com/matches/${esMatchId}/info`,
      { headers, cache: "no-store" }
    )
    if (!infoRes || !infoRes.ok) {
      const code = infoRes ? infoRes.status : "timeout"
      return { players: null, reason: `matched_${esMatchId}_info_http_${code}` }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const infoData: any = await infoRes.json()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teama = infoData?.response?.squads?.teama as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teamb = infoData?.response?.squads?.teamb as any

    // Team names — prefer the top-level teama/teamb.name (matches our stored
    // DB team names when cricapi & EntitySport use the same convention), but
    // fall back to the nested squads object if needed.
    const teamAName = infoData?.response?.teama?.name
      ?? teama?.name
      ?? team1
    const teamBName = infoData?.response?.teamb?.name
      ?? teamb?.name
      ?? team2

    const out: EntitySportSquadPlayer[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pushSquad = (squadObj: any, teamName: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr: any[] = squadObj?.squads ?? squadObj?.players ?? []
      for (const p of arr) {
        const pid = String(p.player_id ?? p.pid ?? "")
        const name = String(p.name ?? p.title ?? "").trim()
        if (!pid || !name) continue
        // EntitySport encodes booleans as strings ("true"/"false") — normalise.
        const sub = String(p.substitute ?? "").toLowerCase() === "true"
        const playing11 = String(p.playing11 ?? "").toLowerCase() === "true"
        out.push({
          es_player_id: pid,
          name,
          team: teamName,
          role: mapEntitySportRole(p.role ?? p.playing_role ?? ""),
          es_substitute: sub,
          es_playing11: playing11,
        })
      }
    }
    pushSquad(teama, teamAName)
    pushSquad(teamb, teamBName)

    if (out.length === 0) {
      return { players: null, reason: `matched_${esMatchId}_empty_squads` }
    }
    return { players: out, reason: `ok_${out.length}` }
  } catch (e) {
    return { players: null, reason: `error:${String(e).slice(0, 60)}` }
  }
}

// Back-compat wrapper — used by finalize/refinalize which don't need the
// reason string.  New callers should prefer `fetchEntitySportScorecardDetailed`.
export async function fetchEntitySportScorecard(team1: string, team2: string): Promise<unknown[] | null> {
  const r = await fetchEntitySportScorecardDetailed(team1, team2)
  return r.scorecard
}

// ─── Cricbuzz /scard (tertiary live fallback) ────────────────────────────────
//
// Why this exists: EntitySport went fully dark on 2026-04-22 during a live
// match (all 5 listing URLs returned empty / 429).  Cricbuzz's quota has been
// a moving target — sometimes exhausted, sometimes not — so the value of
// keeping it as a "free parallel attempt" is asymmetric: if it's dead it
// costs us 20s of wasted timeout per poll (in parallel with other sources,
// so real latency is unaffected); if it's alive it's the only thing between
// us and a scoreboard freeze.
//
// Restored on 2026-04-22 from the pre-refactor route.ts (commit f41a10d).
// Only used by the LIVE path — finalize/refinalize deliberately exclude it
// (its data quality has been inconsistent, and for prize payouts we'd rather
// fail loudly than settle on bad Cricbuzz data).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertCricbuzzScorecard(scoreCard: any[]): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return scoreCard.map((innings: any) => {
    const batTeamName: string =
      innings.batteamname ?? innings.batTeamDetails?.batTeamName ?? "Unknown"
    const inningsId: number = innings.inningsid ?? innings.inningsId ?? 1

    const batsmenRaw = innings.batsman ?? innings.batTeamDetails?.batsmenData ?? {}
    const batsmenList: unknown[] = Array.isArray(batsmenRaw)
      ? batsmenRaw
      : (batsmenRaw && typeof batsmenRaw === "object") ? Object.values(batsmenRaw) : []

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

    const bowlersRaw = innings.bowler ?? innings.bowlTeamDetails?.bowlersData ?? {}
    const bowlersList: unknown[] = Array.isArray(bowlersRaw) ? bowlersRaw : Object.values(bowlersRaw)

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

    // Fielding extracted from fall-of-wickets when available.  Much less
    // reliable than EntitySport's dedicated fielder arrays — prefer EntitySport
    // for catch/stumping credit when both are present.
    const fowRaw = innings.fow ?? innings.wicketsData ?? {}
    const fowList: unknown[] = Array.isArray(fowRaw) ? fowRaw : Object.values(fowRaw)
    const fielderMap = new Map<string, { id: string; name: string; catch: number; stumped: number; runout: number; cb: number }>()
    for (const wicket of fowList) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = wicket as any
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

    return { inning: `${batTeamName} Inning ${inningsId}`, batting, bowling, catching }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenCricbuzzMatches(data: any): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = []
  for (const typeMatch of (data.typeMatches ?? [])) {
    for (const seriesMatch of (typeMatch.seriesMatches ?? [])) {
      const candidates = [
        seriesMatch.seriesAdWrapper?.matches,
        seriesMatch.matches,
        seriesMatch.adWrapper?.matches,
      ]
      for (const list of candidates) {
        if (Array.isArray(list)) all.push(...list)
      }
    }
  }
  return all
}

export async function fetchCricbuzzScorecardDetailed(
  team1: string,
  team2: string
): Promise<{ scorecard: unknown[] | null; reason: string }> {
  if (!CRICBUZZ_API_KEY) return { scorecard: null, reason: "no_api_key" }
  if (!team1 || !team2) return { scorecard: null, reason: "no_teams" }

  try {
    const headers = {
      "X-RapidAPI-Key": CRICBUZZ_API_KEY,
      "X-RapidAPI-Host": "cricbuzz-cricket.p.rapidapi.com",
    }

    const tokens = (name: string): string[] => {
      const parts = name.toLowerCase().split(/\s+/).filter(Boolean)
      const toks = new Set<string>([name.toLowerCase(), ...parts])
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
          mi.team1?.teamName ?? "", mi.team1?.teamSName ?? "",
          mi.team2?.teamName ?? "", mi.team2?.teamSName ?? "",
        ].join(" ")
        return hits(haystack, t1) && hits(haystack, t2)
      })

    const statuses: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let found: any = null
    for (const endpoint of ["live", "recent"]) {
      const r = await timedFetch(`https://cricbuzz-cricket.p.rapidapi.com/matches/v1/${endpoint}`, {
        headers, cache: "no-store",
      })
      if (!r) { statuses.push(`${endpoint}:TO`); continue }
      if (!r.ok) { statuses.push(`${endpoint}:${r.status}`); continue }
      try {
        const data = await r.json()
        found = findInList(flattenCricbuzzMatches(data))
        statuses.push(`${endpoint}:200`)
        if (found) break
      } catch {
        statuses.push(`${endpoint}:json-err`)
      }
    }

    if (!found) return { scorecard: null, reason: `no_match [${statuses.join(",")}]` }

    const cbMatchId: number = found.matchInfo.matchId
    const scRes = await timedFetch(`https://cricbuzz-cricket.p.rapidapi.com/mcenter/v1/${cbMatchId}/scard`, {
      headers, cache: "no-store",
    })
    if (!scRes) return { scorecard: null, reason: `matched_${cbMatchId}_scard_TO` }
    if (!scRes.ok) return { scorecard: null, reason: `matched_${cbMatchId}_scard_${scRes.status}` }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scData: any = await scRes.json()

    const scArray = scData.scoreCard ?? scData.scorecard
    if (!Array.isArray(scArray) || scArray.length === 0) {
      return { scorecard: null, reason: `matched_${cbMatchId}_empty_scard` }
    }

    const converted = convertCricbuzzScorecard(scArray)
    const playerCount = converted.reduce((sum: number, inn: unknown) => {
      const i = inn as { batting?: unknown[]; bowling?: unknown[] }
      return sum + (i.batting?.length ?? 0) + (i.bowling?.length ?? 0)
    }, 0)
    if (playerCount === 0) return { scorecard: null, reason: `matched_${cbMatchId}_empty_players` }
    return { scorecard: converted, reason: `ok_${playerCount}` }
  } catch (e) {
    return { scorecard: null, reason: `error:${String(e).slice(0, 60)}` }
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
  // Three sources in parallel.  Cricbuzz was removed in the 2026-04-22
  // refactor but restored the same day when EntitySport went dark mid-match
  // — belt-and-braces wins over code cleanliness for scoring reliability.
  const [cricapiSc, cricapiInfo, esDetailed, cbDetailed] = await Promise.all([
    fetchCricapiScorecard(cricketdataMatchId),
    fetchCricapiMatchInfo(cricketdataMatchId),
    fetchEntitySportScorecardDetailed(team1, team2),
    fetchCricbuzzScorecardDetailed(team1, team2),
  ])

  const esSc = esDetailed.scorecard
  const cbSc = cbDetailed.scorecard
  const cricapiN = cricapiSc ? countScorecardPlayers(cricapiSc as unknown[]) : 0
  const esN = esSc ? countScorecardPlayers(esSc as unknown[]) : 0
  const cbN = cbSc ? countScorecardPlayers(cbSc as unknown[]) : 0

  // Pick the richest of the three.  Tie-breaking preference: cricapi > ES > CB
  // because cricapi's native shape is best, then ES for its dedicated fielder
  // arrays (Dream11-critical for catches), then CB as a last resort (fielding
  // scraped from FOW text is noisy).
  const candidates = [
    { sc: cricapiSc, n: cricapiN, label: "cricapi" },
    { sc: esSc,      n: esN,      label: "entitysport-info" },
    { sc: cbSc,      n: cbN,      label: "cricbuzz" },
  ].filter(c => c.sc && c.n > 0)

  let scorecard: unknown[] | null = null
  let source = "none"
  if (candidates.length > 0) {
    // Sort richest first; stable sort preserves the preference order above for
    // ties.
    candidates.sort((a, b) => b.n - a.n)
    const winner = candidates[0]
    scorecard = winner.sc
    const others = candidates.slice(1).map(c => `${c.label}:${c.n}`).join(",")
    source = others ? `${winner.label} (${winner.n}; others: ${others})` : `${winner.label} (${winner.n})`
  }

  const liveInProgress = !scorecard && !!cricapiInfo && cricapiInfo.matchStarted && !cricapiInfo.matchEnded
  const notStarted = !scorecard && !!cricapiInfo && !cricapiInfo.matchStarted

  const infoStr = cricapiInfo
    ? `info:started=${cricapiInfo.matchStarted},ended=${cricapiInfo.matchEnded},fantasy=${cricapiInfo.fantasyEnabled}`
    : "info:unavailable"
  // Include the reason from both fallback sources — this is the data we need
  // to diagnose "all zero" failures without fishing through Vercel logs.
  const detail = `cricapi:${cricapiN} | es:${esN} (${esDetailed.reason}) | cb:${cbN} (${cbDetailed.reason}) | ${infoStr} | source:${source}`

  return { scorecard, source, liveInProgress, notStarted, detail }
}
