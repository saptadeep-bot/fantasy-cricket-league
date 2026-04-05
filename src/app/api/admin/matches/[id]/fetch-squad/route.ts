import { auth } from "@/auth"
import { NextRequest, NextResponse } from "next/server"

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

function mapRole(role: string): string {
  const r = role.toLowerCase()
  if (r.includes("wk") || r.includes("wicket")) return "WK"
  if (r.includes("bowling allrounder") || r.includes("all-rounder") || r.includes("allrounder")) return "ALL"
  if (r.includes("batting allrounder")) return "ALL"
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

  const { supabaseAdmin } = await import("@/lib/supabase")

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("cricketdata_match_id, team1, team2")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })

  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_squad?apikey=${CRICKETDATA_API_KEY}&id=${match.cricketdata_match_id}`,
      { cache: "no-store" }
    )
    const data = await res.json()

    if (data.status !== "success") {
      return NextResponse.json({ error: "API error: " + JSON.stringify(data) }, { status: 500 })
    }

    const teams: any[] = data.data || []
    const players: any[] = []

    for (const team of teams) {
      const teamName = team.teamName || team.teamInfo?.name || team.team || "Unknown"
      const squad: any[] = team.players || team.squad || []

      for (const player of squad) {
        players.push({
          cricketdata_player_id: player.id,
          name: player.name,
          team: teamName,
          role: mapRole(player.role || player.playerRole || ""),
        })
      }
    }

    // Save full squad to DB so users can start picking teams immediately
    const { supabaseAdmin } = await import("@/lib/supabase")
    await supabaseAdmin.from("match_players").delete().eq("match_id", id)
    const { error: insertError } = await supabaseAdmin.from("match_players").insert(
      players.map(p => ({
        match_id: id,
        cricketdata_player_id: p.cricketdata_player_id,
        name: p.name,
        team: p.team,
        role: p.role,
        is_playing: false,
        fantasy_points: 0,
      }))
    )
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })

    return NextResponse.json({ success: true, players })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
