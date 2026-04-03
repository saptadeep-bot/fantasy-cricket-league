import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

const SERIES_ID = "87c62aac-bc3c-4738-ab93-19da0690488f"
const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

// Map match number to type
function getMatchType(matchNumber: number, totalMatches: number): string {
  // Playoffs are the last 4 matches
  if (matchNumber === totalMatches - 3) return "qualifier1"
  if (matchNumber === totalMatches - 2) return "eliminator"
  if (matchNumber === totalMatches - 1) return "qualifier2"
  if (matchNumber === totalMatches) return "final"
  return "league"
}

function getBasePrize(matchType: string): number {
  switch (matchType) {
    case "qualifier1": return 500
    case "qualifier2": return 500
    case "eliminator": return 500
    case "final": return 1200
    default: return 140
  }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/series_info?apikey=${CRICKETDATA_API_KEY}&id=${SERIES_ID}`
    )
    const data = await res.json()

    if (data.status !== "success") {
      return NextResponse.json({ error: "API error", details: data }, { status: 500 })
    }

    const matches = data.data?.matchList || []
    const totalMatches = matches.length

    let imported = 0
    let skipped = 0

    for (const [index, match] of matches.entries()) {
      const matchNumber = index + 1
      const matchType = getMatchType(matchNumber, totalMatches)
      const basePrize = getBasePrize(matchType)

      const { error } = await supabaseAdmin.from("matches").upsert({
        cricketdata_match_id: match.id,
        name: match.name,
        match_number: matchNumber,
        match_type: matchType,
        team1: match.teams?.[0] || "TBD",
        team2: match.teams?.[1] || "TBD",
        venue: match.venue,
        scheduled_at: match.dateTimeGMT,
        status: "upcoming",
        base_prize: basePrize,
        rollover_added: 0,
      }, { onConflict: "cricketdata_match_id" })

      if (error) {
        console.error(`Failed to import match ${matchNumber}:`, error)
        skipped++
      } else {
        imported++
      }
    }

    return NextResponse.json({ success: true, imported, skipped, total: totalMatches })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
