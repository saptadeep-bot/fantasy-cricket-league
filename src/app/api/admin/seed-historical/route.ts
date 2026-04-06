import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextResponse } from "next/server"

const ENTRY_FEE = 250

// Historical matches played before the app was built
const HISTORICAL_MATCHES = [
  {
    key: "pre-app-match-1",
    label: "Pre-App Match 1",
    matchNumber: -6,
    scheduledAt: "2026-03-22T14:00:00Z",
    participants: 5,      // all 5 players
    firstNames: ["Ashish", "Saptadeep", "Raj", "Nitin", "Ranadurjay"],
    first: "Ashish",
    second: "Saptadeep",
  },
  {
    key: "pre-app-match-2",
    label: "Pre-App Match 2",
    matchNumber: -5,
    scheduledAt: "2026-03-24T14:00:00Z",
    participants: 4,      // Ranadurjay did not play
    firstNames: ["Ashish", "Saptadeep", "Raj", "Nitin"],
    first: "Raj",
    second: "Ashish",
  },
  {
    key: "pre-app-match-3",
    label: "Pre-App Match 3",
    matchNumber: -4,
    scheduledAt: "2026-03-26T14:00:00Z",
    participants: 4,      // Ranadurjay did not play
    firstNames: ["Ashish", "Saptadeep", "Raj", "Nitin"],
    first: "Nitin",
    second: "Ashish",
  },
  {
    key: "pre-app-match-4",
    label: "Pre-App Match 4",
    matchNumber: -3,
    scheduledAt: "2026-03-28T14:00:00Z",
    participants: 5,      // all 5 players
    firstNames: ["Ashish", "Saptadeep", "Raj", "Nitin", "Ranadurjay"],
    first: "Ashish",
    second: "Saptadeep",
  },
  {
    key: "pre-app-match-5",
    label: "Pre-App Match 5",
    matchNumber: -2,
    scheduledAt: "2026-03-30T14:00:00Z",
    participants: 5,      // all 5 players
    firstNames: ["Ashish", "Saptadeep", "Raj", "Nitin", "Ranadurjay"],
    first: "Saptadeep",
    second: "Ashish",
  },
  {
    key: "pre-app-match-6",
    label: "Pre-App Match 6",
    matchNumber: -1,
    scheduledAt: "2026-04-01T14:00:00Z",
    participants: 4,      // Ranadurjay did not play
    firstNames: ["Ashish", "Saptadeep", "Raj", "Nitin"],
    first: "Ashish",
    second: "Raj",
  },
]

export async function POST() {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Fetch all users
  const { data: users, error: usersError } = await supabaseAdmin.from("users").select("id, name")
  if (usersError || !users) {
    return NextResponse.json({ error: "Could not fetch users" }, { status: 500 })
  }

  // Helper: find user by first name (case-insensitive)
  function findUser(firstName: string) {
    return users.find(u => u.name.toLowerCase().startsWith(firstName.toLowerCase()))
  }

  // Check all needed users exist
  const allNames = [...new Set(HISTORICAL_MATCHES.flatMap(m => m.firstNames))]
  const missing = allNames.filter(n => !findUser(n))
  if (missing.length > 0) {
    return NextResponse.json({ error: `Could not find users: ${missing.join(", ")}. Check names in DB.` }, { status: 400 })
  }

  const summary = []

  for (const hm of HISTORICAL_MATCHES) {
    // Skip if already seeded
    const { data: existing } = await supabaseAdmin
      .from("matches")
      .select("id")
      .eq("cricketdata_match_id", hm.key)
      .single()

    if (existing) {
      summary.push({ match: hm.label, status: "already exists — skipped" })
      continue
    }

    // Insert historical match record
    const { data: matchRow, error: matchErr } = await supabaseAdmin
      .from("matches")
      .insert({
        cricketdata_match_id: hm.key,
        name: hm.label,
        match_number: hm.matchNumber,
        match_type: "league",
        team1: "N/A",
        team2: "N/A",
        venue: "Pre-Season",
        scheduled_at: hm.scheduledAt,
        status: "completed",
        base_prize: 250,
        rollover_added: 0,
      })
      .select("id")
      .single()

    if (matchErr || !matchRow) {
      summary.push({ match: hm.label, status: `error creating match: ${matchErr?.message}` })
      continue
    }

    const matchId = matchRow.id
    const totalPool = ENTRY_FEE * hm.participants
    const firstPrize = Math.round(totalPool * 0.65)
    const secondPrize = totalPool - firstPrize

    // Build results for each participant
    const firstUser = findUser(hm.first)!
    const secondUser = findUser(hm.second)!

    const results = hm.firstNames.map(name => {
      const user = findUser(name)!
      const isFirst = user.id === firstUser.id
      const isSecond = user.id === secondUser.id
      return {
        match_id: matchId,
        user_id: user.id,
        rank: isFirst ? 1 : isSecond ? 2 : 3,
        raw_points: 0,
        final_points: 0,
        prize_won: isFirst ? firstPrize : isSecond ? secondPrize : 0,
        is_settled: false,
      }
    })

    const { error: resultsErr } = await supabaseAdmin.from("match_results").insert(results)
    if (resultsErr) {
      summary.push({ match: hm.label, status: `error inserting results: ${resultsErr.message}` })
      continue
    }

    summary.push({
      match: hm.label,
      participants: hm.participants,
      pool: `₹${totalPool}`,
      first: `${hm.first} → ₹${firstPrize}`,
      second: `${hm.second} → ₹${secondPrize}`,
      status: "seeded ✓",
    })
  }

  return NextResponse.json({ success: true, summary })
}

// Allow re-running to delete and re-seed (admin only)
export async function DELETE() {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const keys = HISTORICAL_MATCHES.map(m => m.key)
  const { data: matches } = await supabaseAdmin
    .from("matches")
    .select("id")
    .in("cricketdata_match_id", keys)

  if (matches && matches.length > 0) {
    const ids = matches.map(m => m.id)
    await supabaseAdmin.from("match_results").delete().in("match_id", ids)
    await supabaseAdmin.from("matches").delete().in("id", ids)
  }

  return NextResponse.json({ success: true, deleted: matches?.length || 0 })
}
