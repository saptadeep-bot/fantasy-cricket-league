import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

interface TeamSubmission {
  playerIds: string[]
  captainId: string
  viceCaptainId: string
}

function validateTeam(
  playerIds: string[],
  captainId: string,
  vcId: string,
  players: any[]
): string | null {
  if (playerIds.length !== 11) return "Select exactly 11 players"
  if (!captainId || !vcId) return "Select a captain and vice-captain"
  if (captainId === vcId) return "Captain and vice-captain must be different"
  if (!playerIds.includes(captainId)) return "Captain must be in your team"
  if (!playerIds.includes(vcId)) return "Vice-captain must be in your team"

  const selected = players.filter(p => playerIds.includes(p.cricketdata_player_id))
  const teamCount: Record<string, number> = {}

  for (const p of selected) {
    teamCount[p.team] = (teamCount[p.team] || 0) + 1
  }

  const teamNames = Object.keys(teamCount)
  if (teamNames.length < 2) return "Select players from both teams"
  if (Math.min(...Object.values(teamCount)) < 4) return "Select at least 4 players from each team"

  return null
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { playerIds, captainId, viceCaptainId }: TeamSubmission = await req.json()

  // Check match is locked (team selection open) or upcoming
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("status")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  if (!["locked", "upcoming"].includes(match.status)) {
    return NextResponse.json({ error: "Team selection is closed for this match" }, { status: 400 })
  }

  // Fetch match players for validation
  const { data: players } = await supabaseAdmin
    .from("match_players")
    .select("*")
    .eq("match_id", id)

  if (!players?.length) return NextResponse.json({ error: "Playing XI not set yet" }, { status: 400 })

  const validationError = validateTeam(playerIds, captainId, viceCaptainId, players)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  // Upsert team (insert or update if already exists)
  const { error } = await supabaseAdmin.from("teams").upsert({
    user_id: session.user.id,
    match_id: id,
    player_ids: playerIds,
    captain_id: captainId,
    vice_captain_id: viceCaptainId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,match_id" })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: team } = await supabaseAdmin
    .from("teams")
    .select("*")
    .eq("match_id", id)
    .eq("user_id", session.user.id)
    .single()

  return NextResponse.json({ team: team || null })
}
