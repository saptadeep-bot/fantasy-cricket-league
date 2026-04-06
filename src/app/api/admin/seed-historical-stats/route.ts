import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextResponse } from "next/server"

// Pre-calculated historical stats (6 matches before the app was built)
// Entry fee ₹250 per match, 65/35 split
const HISTORICAL_STATS: Record<string, {
  extra_matches_played: number
  extra_first_wins: number
  extra_second_wins: number
  extra_invested: number
  extra_prize_won: number
}> = {
  "Ashish":      { extra_matches_played: 6, extra_first_wins: 3, extra_second_wins: 3, extra_invested: 1500, extra_prize_won: 3413 },
  "Saptadeep":   { extra_matches_played: 6, extra_first_wins: 1, extra_second_wins: 2, extra_invested: 1500, extra_prize_won: 1687 },
  "Raj":         { extra_matches_played: 6, extra_first_wins: 1, extra_second_wins: 1, extra_invested: 1500, extra_prize_won: 1000 },
  "Nitin":       { extra_matches_played: 6, extra_first_wins: 1, extra_second_wins: 0, extra_invested: 1500, extra_prize_won: 650  },
  "Ranadurjay":  { extra_matches_played: 3, extra_first_wins: 0, extra_second_wins: 0, extra_invested: 750,  extra_prize_won: 0    },
}

export async function POST() {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: users } = await supabaseAdmin.from("users").select("id, name")
  if (!users) return NextResponse.json({ error: "Could not fetch users" }, { status: 500 })

  const summary = []

  for (const [firstName, stats] of Object.entries(HISTORICAL_STATS)) {
    const user = users.find(u => u.name.toLowerCase().startsWith(firstName.toLowerCase()))
    if (!user) {
      summary.push({ name: firstName, status: "user not found — skipped" })
      continue
    }

    const { error } = await supabaseAdmin
      .from("player_historical_stats")
      .upsert({ user_id: user.id, ...stats }, { onConflict: "user_id" })

    if (error) {
      summary.push({ name: firstName, status: `error: ${error.message}` })
    } else {
      summary.push({
        name: firstName,
        status: "saved ✓",
        matches: stats.extra_matches_played,
        invested: `₹${stats.extra_invested}`,
        won: `₹${stats.extra_prize_won}`,
        pnl: `${stats.extra_prize_won - stats.extra_invested >= 0 ? "+" : ""}₹${stats.extra_prize_won - stats.extra_invested}`,
      })
    }
  }

  return NextResponse.json({ success: true, summary })
}

export async function DELETE() {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await supabaseAdmin.from("player_historical_stats").delete().neq("user_id", "00000000-0000-0000-0000-000000000000")
  return NextResponse.json({ success: true })
}
