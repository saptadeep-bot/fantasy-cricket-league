import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

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

  // Fetch scorecard from API
  const scRes = await fetch(
    `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${match.cricketdata_match_id}`,
    { cache: "no-store" }
  )
  const scData = await scRes.json()

  const scorecard = scData.data?.scorecard ?? []
  const pointsMap = scorecard.length > 0 ? calculateFantasyPoints(scorecard) : new Map()

  // Players from DB
  const { data: dbPlayers } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name, fantasy_points")
    .eq("match_id", id)

  // Show name matching result
  const norm = (s: string) => s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()
  const namesMatch = (a: string, b: string) => {
    const na = norm(a); const nb = norm(b)
    if (na === nb) return true
    const pa = na.split(" "); const pb = nb.split(" ")
    if (pa[pa.length - 1] !== pb[pb.length - 1]) return false
    const fa = pa[0]; const fb = pb[0]
    if (fa === fb) return true
    if (fa.length === 1 && fb.startsWith(fa)) return true
    if (fb.length === 1 && fa.startsWith(fb)) return true
    if (fa.length <= 3 && fa[0] === fb[0]) return true
    if (fb.length <= 3 && fb[0] === fa[0]) return true
    return false
  }

  const dbIds = new Set((dbPlayers || []).map(p => p.cricketdata_player_id))
  const matchResults = []
  for (const [pid, pts] of pointsMap.entries()) {
    const directMatch = dbIds.has(pid)
    const nameMatch = directMatch ? null : (dbPlayers || []).find(p => namesMatch(pts.name, p.name))
    matchResults.push({
      scorecardName: pts.name,
      scorecardId: pid,
      points: Math.round(pts.total * 10) / 10,
      matchType: directMatch ? "ID_MATCH" : nameMatch ? `NAME_MATCH → ${nameMatch.name}` : "NO_MATCH",
    })
  }

  return NextResponse.json({
    match: { name: match.name, status: match.status, apiId: match.cricketdata_match_id },
    apiStatus: scData.status,
    apiReason: scData.reason || scData.message || null,
    scorecardInnings: scorecard.length,
    pointsMapSize: pointsMap.size,
    dbPlayerCount: (dbPlayers || []).length,
    matching: matchResults,
    scorecardRaw: scorecard.length > 0 ? scorecard[0] : null, // first innings sample
  })
}
