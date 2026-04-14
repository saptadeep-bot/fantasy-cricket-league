import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { getEntryFee, calcPrizes } from "@/lib/prizes"
import { NextResponse } from "next/server"

export async function POST() {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: matches } = await supabaseAdmin
    .from("matches")
    .select("id, match_number, team1, team2, match_type")
    .eq("status", "completed")
    .order("scheduled_at", { ascending: true })

  if (!matches || matches.length === 0) {
    return NextResponse.json({ message: "No completed matches found." })
  }

  const summary = []

  for (const match of matches) {
    const { data: existingResults } = await supabaseAdmin
      .from("match_results")
      .select("user_id, rank, raw_points, final_points")
      .eq("match_id", match.id)
      .order("final_points", { ascending: false })

    if (!existingResults || existingResults.length === 0) {
      summary.push({ match: `M${match.match_number}`, status: "skipped — no results" })
      continue
    }

    const ENTRY_FEE = getEntryFee(match.match_type)
    const totalPool = ENTRY_FEE * existingResults.length

    const prizeResults = calcPrizes(existingResults, totalPool, ENTRY_FEE)

    for (const r of prizeResults) {
      await supabaseAdmin
        .from("match_results")
        .update({ prize_won: r.prize_won })
        .eq("match_id", match.id)
        .eq("user_id", r.user_id)
    }

    summary.push({
      match: `M${match.match_number} (${match.team1} vs ${match.team2})`,
      participants: existingResults.length,
      totalPool,
      prizes: prizeResults.map(r => `₹${r.prize_won}`).join(", "),
      status: "updated",
    })
  }

  return NextResponse.json({ success: true, summary })
}
