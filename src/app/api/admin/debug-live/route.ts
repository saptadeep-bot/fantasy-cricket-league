import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

export async function GET() {
  const session = await auth()
  if (!session?.user?.is_admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Get our stored live match
  const { data: liveMatch } = await supabaseAdmin
    .from("matches")
    .select("id, name, team1, team2, cricketdata_match_id, status")
    .eq("status", "live")
    .single()

  // Fetch current live matches from cricket API
  const res = await fetch(
    `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=0`,
    { cache: "no-store" }
  )
  const data = await res.json()

  const apiMatches = (data.data || []).map((m: any) => ({
    id: m.id,
    name: m.name,
    status: m.status,
    teams: m.teams,
  }))

  // Try scorecard with stored ID
  let scorecardStatus = "not tried"
  if (liveMatch?.cricketdata_match_id) {
    const scRes = await fetch(
      `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${liveMatch.cricketdata_match_id}`,
      { cache: "no-store" }
    )
    const scData = await scRes.json()
    scorecardStatus = scData.status === "success" ? "OK" : (scData.reason || scData.message || "failed")
  }

  return NextResponse.json({
    ourLiveMatch: liveMatch,
    scorecardStatus,
    liveMatchesFromAPI: apiMatches,
  })
}

// Fix: update the stored match ID with the correct one from API
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.is_admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { matchId, newCricketdataId } = await req.json()

  const { error } = await supabaseAdmin
    .from("matches")
    .update({ cricketdata_match_id: newCricketdataId })
    .eq("id", matchId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
