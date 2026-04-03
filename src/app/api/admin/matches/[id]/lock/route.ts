import { auth } from "@/auth"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

function mapRole(role: string): string {
  const r = (role || "").toLowerCase()
  if (r.includes("wk") || r.includes("wicket")) return "WK"
  if (r.includes("allrounder") || r.includes("all-rounder")) return "ALL"
  if (r.includes("bowler") || r.includes("bowling")) return "BOWL"
  if (r.includes("batsman") || r.includes("batter") || r.includes("batting")) return "BAT"
  return "BAT"
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { selectedPlayerIds }: { selectedPlayerIds: string[] } = await req.json()

  if (!selectedPlayerIds || selectedPlayerIds.length === 0) {
    return NextResponse.json({ error: "No players provided" }, { status: 400 })
  }

  const { supabaseAdmin } = await import("@/lib/supabase")

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("id, cricketdata_match_id, team1, team2, status")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  if (match.status !== "upcoming") return NextResponse.json({ error: "Match already locked" }, { status: 400 })

  try {
    // Fetch full squad to get player details for selected IDs
    const res = await fetch(
      `https://api.cricapi.com/v1/match_squad?apikey=${CRICKETDATA_API_KEY}&id=${match.cricketdata_match_id}`
    )
    const data = await res.json()

    const allPlayers: any[] = []
    for (const team of (data.data || [])) {
      const teamName = team.teamName || team.teamInfo?.name || team.team || "Unknown"
      for (const player of (team.players || team.squad || [])) {
        allPlayers.push({
          cricketdata_player_id: player.id,
          name: player.name,
          team: teamName,
          role: mapRole(player.role || player.playerRole || ""),
        })
      }
    }

    // Filter to only selected playing XI players
    const playingXI = allPlayers.filter(p => selectedPlayerIds.includes(p.cricketdata_player_id))

    // Delete any existing players for this match
    await supabaseAdmin.from("match_players").delete().eq("match_id", id)

    // Insert playing XI
    const { error: insertError } = await supabaseAdmin.from("match_players").insert(
      playingXI.map(p => ({
        match_id: id,
        cricketdata_player_id: p.cricketdata_player_id,
        name: p.name,
        team: p.team,
        role: p.role,
        is_playing: true,
        fantasy_points: 0,
      }))
    )

    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })

    // Keep status as upcoming — team selection is now open
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
