import { auth } from "@/auth"
import { NextRequest, NextResponse } from "next/server"

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
    .select("status")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  if (match.status !== "upcoming") return NextResponse.json({ error: "Match already locked" }, { status: 400 })

  // Check squad has been fetched
  const { data: existingPlayers } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id")
    .eq("match_id", id)

  if (!existingPlayers?.length) {
    return NextResponse.json({ error: "Please fetch squad first" }, { status: 400 })
  }

  // Mark all as not playing, then mark selected as playing
  await supabaseAdmin.from("match_players").update({ is_playing: false }).eq("match_id", id)
  const { error } = await supabaseAdmin
    .from("match_players")
    .update({ is_playing: true })
    .eq("match_id", id)
    .in("cricketdata_player_id", selectedPlayerIds)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
