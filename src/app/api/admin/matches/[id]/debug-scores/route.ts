import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

async function fetchJson(url: string) {
  try {
    const r = await fetch(url, { cache: "no-store" })
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

  // Try every relevant cricapi endpoint in parallel
  const [scorecard, matchInfo, currentMatches] = await Promise.all([
    fetchJson(`https://api.cricapi.com/v1/match_scorecard?${KEY}&id=${mid}`),
    fetchJson(`https://api.cricapi.com/v1/match_info?${KEY}&id=${mid}`),
    fetchJson(`https://api.cricapi.com/v1/currentMatches?${KEY}&offset=0`),
  ])

  // Try series_info if we have a series_id
  const seriesId = matchInfo?.data?.series_id
  const seriesInfo = seriesId
    ? await fetchJson(`https://api.cricapi.com/v1/series_info?${KEY}&id=${seriesId}`)
    : null

  // Find our match in currentMatches to see full live data structure
  const liveMatch = (currentMatches?.data || []).find((m: { id: string }) => m.id === mid)

  return NextResponse.json({
    storedMatchId: mid,
    matchName: match.name,

    // What each endpoint returns
    endpoints: {
      match_scorecard: {
        status: scorecard?.status,
        reason: scorecard?.reason || scorecard?.message,
        hasScorecard: Array.isArray(scorecard?.data?.scorecard),
        scorecardLength: scorecard?.data?.scorecard?.length ?? 0,
        dataKeys: scorecard?.data ? Object.keys(scorecard.data) : null,
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
      currentMatches_liveEntry: liveMatch
        ? {
            id: liveMatch.id,
            name: liveMatch.name,
            status: liveMatch.status,
            score: liveMatch.score,
            fantasyEnabled: liveMatch.fantasyEnabled,
            bbbEnabled: liveMatch.bbbEnabled,
            dataKeys: Object.keys(liveMatch),
          }
        : "NOT FOUND in currentMatches",
      series_info: seriesInfo
        ? {
            status: seriesInfo?.status,
            dataKeys: seriesInfo?.data ? Object.keys(seriesInfo.data) : null,
            matchCount: seriesInfo?.data?.matchList?.length ?? seriesInfo?.data?.matches?.length ?? "unknown",
          }
        : "skipped (no series_id)",
    },
  })
}
