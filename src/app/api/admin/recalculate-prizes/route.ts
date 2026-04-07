import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextResponse } from "next/server"

function getEntryFee(matchType: string): number {
  const type = (matchType || "league").toLowerCase()
  if (type === "final") return 500
  if (type === "eliminator" || type === "qualifier" || type.includes("qualifier") || type.includes("eliminator")) return 350
  return 250
}

export async function POST() {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Fetch all completed matches
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
    // Get all teams for this match
    const { data: teams } = await supabaseAdmin
      .from("teams")
      .select("user_id")
      .eq("match_id", match.id)

    if (!teams || teams.length === 0) {
      summary.push({ match: `M${match.match_number}`, status: "skipped — no teams" })
      continue
    }

    // Get existing results (already ranked + have final_points)
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
    const participants = existingResults.length
    const totalPool = ENTRY_FEE * participants

    // Recalculate prizes
    const updated: Array<{ user_id: string; prize_won: number }> = []

    if (participants === 1) {
      updated.push({ user_id: existingResults[0].user_id, prize_won: ENTRY_FEE })
    } else if (participants === 2) {
      // 2 players — winner takes all
      const firstPlaceScore = existingResults[0].final_points
      const firstPlacers = existingResults.filter(r => r.final_points === firstPlaceScore)
      const prizePerFirst = Math.round(totalPool / firstPlacers.length)
      for (const r of existingResults) {
        updated.push({ user_id: r.user_id, prize_won: firstPlacers.find(f => f.user_id === r.user_id) ? prizePerFirst : 0 })
      }
    } else {
      const firstPlaceScore = existingResults[0].final_points
      const firstPlacers = existingResults.filter(r => r.final_points === firstPlaceScore)
      const nonFirst = existingResults.filter(r => r.final_points < firstPlaceScore)
      const secondPlacers = nonFirst.length > 0
        ? nonFirst.filter(r => r.final_points === nonFirst[0].final_points)
        : []

      const firstPrize = secondPlacers.length === 0 ? totalPool : Math.round(totalPool * 0.65)
      const secondPrize = secondPlacers.length > 0 ? totalPool - firstPrize : 0
      const prizePerFirst = Math.round(firstPrize / firstPlacers.length)
      const prizePerSecond = secondPlacers.length > 0 ? Math.round(secondPrize / secondPlacers.length) : 0

      for (const r of existingResults) {
        let prize = 0
        if (firstPlacers.find(f => f.user_id === r.user_id)) prize = prizePerFirst
        else if (secondPlacers.find(s => s.user_id === r.user_id)) prize = prizePerSecond
        updated.push({ user_id: r.user_id, prize_won: prize })
      }
    }

    // Update prize_won for each result
    for (const u of updated) {
      await supabaseAdmin
        .from("match_results")
        .update({ prize_won: u.prize_won })
        .eq("match_id", match.id)
        .eq("user_id", u.user_id)
    }

    summary.push({
      match: `M${match.match_number} (${match.team1} vs ${match.team2})`,
      participants,
      totalPool,
      prizes: updated.map(u => `₹${u.prize_won}`).join(", "),
      status: "updated",
    })
  }

  return NextResponse.json({ success: true, summary })
}
