import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!
const CRICBUZZ_API_KEY = process.env.CRICBUZZ_API_KEY

async function fetchJson(url: string, opts?: RequestInit) {
  try {
    const r = await fetch(url, { cache: "no-store", ...opts })
    return await r.json()
  } catch (e) {
    return { error: String(e) }
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("id, name, team1, team2, status, cricketdata_match_id")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })

  const mid = match.cricketdata_match_id
  const KEY = `apikey=${CRICKETDATA_API_KEY}`

  // ── cricapi endpoints ────────────────────────────────────────────────────────
  const [scorecard, matchInfo, currentMatches0, currentMatches25, matchBbb] = await Promise.all([
    fetchJson(`https://api.cricapi.com/v1/match_scorecard?${KEY}&id=${mid}`),
    fetchJson(`https://api.cricapi.com/v1/match_info?${KEY}&id=${mid}`),
    fetchJson(`https://api.cricapi.com/v1/currentMatches?${KEY}&offset=0`),
    fetchJson(`https://api.cricapi.com/v1/currentMatches?${KEY}&offset=25`),
    fetchJson(`https://api.cricapi.com/v1/match_bbb?${KEY}&id=${mid}`),
  ])
  // Merge all live matches and find any entry matching our teams (could be a different ID)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allLiveMatches: any[] = [...(currentMatches0?.data ?? []), ...(currentMatches25?.data ?? [])]
  const currentMatches = currentMatches0  // keep for liveMatch lookup below
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMatchesForTeams = allLiveMatches.filter((m: any) => {
    const teams: string[] = m.teams ?? []
    const hasT1 = teams.some((t: string) => t.toLowerCase().includes(match.team1.split(" ")[0].toLowerCase()))
    const hasT2 = teams.some((t: string) => t.toLowerCase().includes(match.team2.split(" ")[0].toLowerCase()))
    return hasT1 && hasT2
  })

  const seriesId = matchInfo?.data?.series_id
  const seriesInfo = seriesId
    ? await fetchJson(`https://api.cricapi.com/v1/series_info?${KEY}&id=${seriesId}`)
    : null

  // Find ALL matches in this series that involve the same teams — there may be duplicate IDs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesMatchList: any[] = seriesInfo?.data?.matchList ?? []
  const t1Lower = match.team1.toLowerCase()
  const t2Lower = match.team2.toLowerCase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sameTeamMatches = seriesMatchList.filter((m: any) => {
    const name: string = (m.name ?? "").toLowerCase()
    return name.includes(t1Lower.split(" ")[0]) || name.includes(t2Lower.split(" ")[0])
  })

  const liveMatch = (currentMatches?.data || []).find((m: { id: string }) => m.id === mid)

  // ── Cricbuzz diagnostics ─────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cricbuzzDiag: Record<string, any> = { skipped: "CRICBUZZ_API_KEY not set in env" }

  if (CRICBUZZ_API_KEY) {
    const cbHeaders = {
      "X-RapidAPI-Key": CRICBUZZ_API_KEY,
      "X-RapidAPI-Host": "cricbuzz-cricket.p.rapidapi.com",
    }

    const cbLive = await fetchJson("https://cricbuzz-cricket.p.rapidapi.com/matches/v1/live", { headers: cbHeaders })

    // ── Show raw top-level structure for debugging ───────────────────────────
    const cbTopLevelKeys = cbLive && typeof cbLive === "object" ? Object.keys(cbLive) : []

    // Try multiple flattening strategies to find matches
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allCbMatches: any[] = []

    // Strategy A: typeMatches[].seriesMatches[].seriesAdWrapper.matches
    for (const typeMatch of (cbLive.typeMatches ?? [])) {
      for (const seriesMatch of (typeMatch.seriesMatches ?? [])) {
        const wrapper = seriesMatch.seriesAdWrapper
        if (!wrapper) continue
        const m = wrapper.matches ?? wrapper.matchList ?? wrapper.matchScheduleList ?? []
        if (Array.isArray(m)) allCbMatches.push(...m)
      }
    }

    // Strategy B: direct matches array at top level
    if (allCbMatches.length === 0 && Array.isArray(cbLive.matches)) {
      allCbMatches.push(...cbLive.matches)
    }

    // Strategy C: matchScheduleMap
    if (allCbMatches.length === 0 && cbLive.matchScheduleMap) {
      for (const key of Object.keys(cbLive.matchScheduleMap)) {
        const entry = cbLive.matchScheduleMap[key]
        const m = entry.matches ?? entry.matchList ?? []
        if (Array.isArray(m)) allCbMatches.push(...m)
      }
    }

    // Token matching
    const tokens = (name: string) => [
      name.toLowerCase(),
      name.split(" ").pop()!.toLowerCase(),
      name.split(" ")[0].toLowerCase(),
    ]
    const t1 = tokens(match.team1)
    const t2 = tokens(match.team2)
    const hits = (haystack: string, toks: string[]) => toks.some(t => haystack.toLowerCase().includes(t))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const foundCb = allCbMatches.find((m: any) => {
      const mi = m.matchInfo
      if (!mi) return false
      const haystack = [
        mi.team1?.teamName ?? "", mi.team1?.teamSName ?? "",
        mi.team2?.teamName ?? "", mi.team2?.teamSName ?? "",
      ].join(" ")
      return hits(haystack, t1) && hits(haystack, t2)
    })

    cricbuzzDiag = {
      liveApiStatus: cbLive.error ? `ERROR: ${cbLive.error}` : "ok",
      rawMessage: cbLive.message ?? null,
      rawTopLevelKeys: cbTopLevelKeys,
      // Show first typeMatch structure for debugging
      firstTypeMatchKeys: cbLive.typeMatches?.[0] ? Object.keys(cbLive.typeMatches[0]) : [],
      firstSeriesMatchKeys: cbLive.typeMatches?.[0]?.seriesMatches?.[0] ? Object.keys(cbLive.typeMatches[0].seriesMatches[0]) : [],
      firstSeriesAdWrapperKeys: cbLive.typeMatches?.[0]?.seriesMatches?.[0]?.seriesAdWrapper ? Object.keys(cbLive.typeMatches[0].seriesMatches[0].seriesAdWrapper) : [],
      typeMatchesCount: cbLive.typeMatches?.length ?? 0,
      totalLiveMatchesFound: allCbMatches.length,
      matchFound: !!foundCb,
      matchInfo: foundCb ? {
        matchId: foundCb.matchInfo?.matchId,
        team1: foundCb.matchInfo?.team1?.teamName,
        team2: foundCb.matchInfo?.team2?.teamName,
        state: foundCb.matchInfo?.state,
      } : null,
      tokenSearch: { team1Tokens: t1, team2Tokens: t2 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sampleLiveMatches: allCbMatches.slice(0, 5).map((m: any) => ({
        matchId: m.matchInfo?.matchId,
        team1: m.matchInfo?.team1?.teamName,
        team2: m.matchInfo?.team2?.teamName,
        state: m.matchInfo?.state,
      })),
    }

    // If match found, also try fetching the scorecard
    if (foundCb) {
      const matchId = foundCb.matchInfo.matchId
      const cbScard = await fetchJson(
        `https://cricbuzz-cricket.p.rapidapi.com/mcenter/v1/${matchId}/scard`,
        { headers: cbHeaders }
      )
      // Use lowercase "scorecard" — that's what Cricbuzz actually returns
      const scArray = cbScard.scoreCard ?? cbScard.scorecard
      const firstInning = Array.isArray(scArray) ? scArray[0] : null
      const firstBatsman = firstInning?.batTeamDetails?.batsmenData
        ? Object.values(firstInning.batTeamDetails.batsmenData)[0]
        : null
      const firstBowler = firstInning?.bowlTeamDetails?.bowlersData
        ? Object.values(firstInning.bowlTeamDetails.bowlersData)[0]
        : null

      cricbuzzDiag.scorecard = {
        rawTopLevelKeys: cbScard && typeof cbScard === "object" ? Object.keys(cbScard) : [],
        isMatchComplete: cbScard.ismatchcomplete,
        scArrayType: typeof scArray,
        isArray: Array.isArray(scArray),
        inningsCount: Array.isArray(scArray) ? scArray.length : 0,
        // First innings structure
        firstInningsKeys: firstInning ? Object.keys(firstInning) : [],
        batTeamDetails_keys: firstInning?.batTeamDetails ? Object.keys(firstInning.batTeamDetails) : [],
        batsmenDataCount: firstInning?.batTeamDetails?.batsmenData
          ? Object.keys(firstInning.batTeamDetails.batsmenData).length : 0,
        bowlersDataCount: firstInning?.bowlTeamDetails?.bowlersData
          ? Object.keys(firstInning.bowlTeamDetails.bowlersData).length : 0,
        // Sample first batsman — shows actual field names
        firstBatsman: firstBatsman ?? null,
        // Sample first bowler
        firstBowler: firstBowler ?? null,
      }

      // Also try the Cricbuzz live endpoint for this match
      const cbLiveMatch = await fetchJson(
        `https://cricbuzz-cricket.p.rapidapi.com/mcenter/v1/${matchId}/live`,
        { headers: cbHeaders }
      )
      cricbuzzDiag.liveMatchEndpoint = {
        topLevelKeys: cbLiveMatch && typeof cbLiveMatch === "object" ? Object.keys(cbLiveMatch) : [],
        hasMiniscore: !!cbLiveMatch?.miniscore,
        miniscoreKeys: cbLiveMatch?.miniscore ? Object.keys(cbLiveMatch.miniscore) : [],
        hasBatTeam: !!cbLiveMatch?.miniscore?.batTeam,
        hasBowlTeam: !!cbLiveMatch?.miniscore?.bowlTeam,
        striker: cbLiveMatch?.miniscore?.batsmanStriker,
        nonStriker: cbLiveMatch?.miniscore?.batsmanNonStriker,
        bowlerStriker: cbLiveMatch?.miniscore?.bowlerStriker,
      }
    }
  }

  // ── Cricket Live Line Advance (RapidAPI) ─────────────────────────────────────
  const RAPIDAPI_KEY = process.env.CRICBUZZ_API_KEY  // reuse same key slot
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cllaDiag: Record<string, any> = { skipped: "no rapidapi key" }

  if (RAPIDAPI_KEY) {
    const cllaHeaders = {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": "cricket-live-line-advance.p.rapidapi.com",
      "Content-Type": "application/json",
    }

    // Step 1: find the live matches list
    const liveList = await fetchJson(
      "https://cricket-live-line-advance.p.rapidapi.com/matches",
      { headers: cllaHeaders }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allCllaMatches: any[] = Array.isArray(liveList)
      ? liveList
      : Array.isArray(liveList?.data)
        ? liveList.data
        : Array.isArray(liveList?.matches)
          ? liveList.matches
          : []

    // Find MI vs PBKS
    const t1 = match.team1.split(" ")[0].toLowerCase()  // "mumbai"
    const t2 = match.team2.split(" ")[0].toLowerCase()  // "punjab"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cllaMatch = allCllaMatches.find((m: any) => {
      const str = JSON.stringify(m).toLowerCase()
      return str.includes(t1) && str.includes(t2)
    })

    cllaDiag = {
      listTopLevelKeys: liveList && typeof liveList === "object" ? Object.keys(liveList) : [],
      totalMatches: allCllaMatches.length,
      matchFound: !!cllaMatch,
      matchSample: cllaMatch ?? null,
      sampleMatches: allCllaMatches.slice(0, 3),
    }

    // Step 2: if found, try the newpoint2 endpoint
    if (cllaMatch) {
      const cllaMatchId = cllaMatch.match_id ?? cllaMatch.id ?? cllaMatch.matchId
      const pts = await fetchJson(
        `https://cricket-live-line-advance.p.rapidapi.com/matches/${cllaMatchId}/newpoint2`,
        { headers: cllaHeaders }
      )
      cllaDiag.points = {
        matchId: cllaMatchId,
        topLevelKeys: pts && typeof pts === "object" ? Object.keys(pts) : [],
        raw: pts,
      }
    }

    // Step 3: also try the example ID 87014 directly
    const pts87014 = await fetchJson(
      "https://cricket-live-line-advance.p.rapidapi.com/matches/87014/newpoint2",
      { headers: cllaHeaders }
    )
    cllaDiag.exampleId87014 = {
      topLevelKeys: pts87014 && typeof pts87014 === "object" ? Object.keys(pts87014) : [],
      statusOrMessage: pts87014?.status ?? pts87014?.message ?? pts87014?.error,
      raw: pts87014,
    }
  }

  return NextResponse.json({
    storedMatchId: mid,
    matchName: match.name,
    team1: match.team1,
    team2: match.team2,
    cricketLiveLineAdvance: cllaDiag,

    endpoints: {
      match_scorecard: {
        status: scorecard?.status,
        reason: scorecard?.reason || scorecard?.message,
        hasScorecard: Array.isArray(scorecard?.data?.scorecard),
        scorecardLength: scorecard?.data?.scorecard?.length ?? 0,
        dataKeys: scorecard?.data ? Object.keys(scorecard.data) : null,
        rawScorecard: scorecard?.data?.scorecard?.slice(0, 2) ?? null,
      },
      match_info: {
        status: matchInfo?.status,
        fantasyEnabled: matchInfo?.data?.fantasyEnabled,
        bbbEnabled: matchInfo?.data?.bbbEnabled,
        matchStarted: matchInfo?.data?.matchStarted,
        matchEnded: matchInfo?.data?.matchEnded,
        score: matchInfo?.data?.score,
        series_id: seriesId,
        dataKeys: matchInfo?.data ? Object.keys(matchInfo.data) : null,
      },
      allCurrentMatchesForTheseTeams: allMatchesForTeams.map((m: { id: string; name: string; fantasyEnabled?: boolean; bbbEnabled?: boolean }) => ({
        id: m.id,
        name: m.name,
        fantasyEnabled: m.fantasyEnabled,
        bbbEnabled: m.bbbEnabled,
      })),
      currentMatches_liveEntry: liveMatch
        ? {
            id: liveMatch.id,
            name: liveMatch.name,
            status: liveMatch.status,
            score: liveMatch.score,
            fantasyEnabled: liveMatch.fantasyEnabled,
            bbbEnabled: liveMatch.bbbEnabled,
          }
        : "NOT FOUND in currentMatches",
      series_info: seriesInfo
        ? {
            status: seriesInfo?.status,
            dataKeys: seriesInfo?.data ? Object.keys(seriesInfo.data) : null,
            totalMatchesInSeries: seriesMatchList.length,
            matchesWithSameTeams: sameTeamMatches.map((m: { id: string; name: string; matchType?: string }) => ({
              id: m.id,
              name: m.name,
              matchType: m.matchType,
            })),
          }
        : "skipped (no series_id)",
    },

    cricbuzz: cricbuzzDiag,

    match_bbb: {
      status: matchBbb?.status,
      reason: matchBbb?.reason || matchBbb?.message,
      hasData: !!matchBbb?.data,
      dataKeys: matchBbb?.data ? Object.keys(matchBbb.data) : null,
      ballCount: Array.isArray(matchBbb?.data?.bbb) ? matchBbb.data.bbb.length : 0,
    },

    diagnosis: {
      fantasyEnabled: matchInfo?.data?.fantasyEnabled ?? liveMatch?.fantasyEnabled ?? "unknown",
      matchStarted: matchInfo?.data?.matchStarted ?? "unknown",
      matchEnded: matchInfo?.data?.matchEnded ?? "unknown",
      scorecardAvailable: Array.isArray(scorecard?.data?.scorecard) && scorecard.data.scorecard.length > 0,
      cricbuzzKeyValid: CRICBUZZ_API_KEY ? (cricbuzzDiag.rawTopLevelKeys?.includes("typeMatches") ? "yes" : `NO — API returned: ${JSON.stringify(cricbuzzDiag.rawMessage)}`) : "not set",
    },
  })
}
