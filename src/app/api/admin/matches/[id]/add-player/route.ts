// Admin manual "Add missing player" endpoint.
//
// Safety valve for the squad-completeness problem — when both cricapi and
// EntitySport fail to return a player that was actually announced (happens
// for late-named impact subs, domestic call-ups, etc.), this lets the admin
// add them by hand from the match setup page.
//
// IDs are minted as `manual_<random>` so they can't collide with cricapi's
// numeric IDs or EntitySport's `es_<id>` IDs.  They're invisible to the
// live-scoring remap logic — if the same player later shows up from a real
// source under a different ID, `match-scoring.ts` will name-match and remap
// away from the manual ID cleanly.

import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"

type Role = "BAT" | "BOWL" | "ALL" | "WK"
const VALID_ROLES: Role[] = ["BAT", "BOWL", "ALL", "WK"]

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { name?: string; team?: string; role?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const name = (body.name ?? "").trim()
  const team = (body.team ?? "").trim()
  const role = (body.role ?? "").trim().toUpperCase() as Role

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })
  if (!team) return NextResponse.json({ error: "team is required" }, { status: 400 })
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of ${VALID_ROLES.join(", ")}` }, { status: 400 })
  }

  // Verify the match exists and the team is one of the two configured for it
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("id, team1, team2")
    .eq("id", id)
    .single()
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  if (team !== match.team1 && team !== match.team2) {
    return NextResponse.json({
      error: `team must be one of "${match.team1}" or "${match.team2}"`,
    }, { status: 400 })
  }

  // Reject duplicates (same name + team already in this match's squad).
  // We compare normalised names so "MS Dhoni" and "ms dhoni" count as the
  // same player.
  const { data: existingSquad } = await supabaseAdmin
    .from("match_players")
    .select("id, name, team, cricketdata_player_id")
    .eq("match_id", id)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim()
  const nName = norm(name)
  const dup = (existingSquad || []).find(p => p.team === team && norm(p.name) === nName)
  if (dup) {
    return NextResponse.json({
      error: `"${dup.name}" already exists in ${team}'s squad`,
    }, { status: 409 })
  }

  const manualId = `manual_${randomBytes(6).toString("hex")}`
  const now = new Date().toISOString()

  const { data: inserted, error } = await supabaseAdmin
    .from("match_players")
    .insert({
      match_id: id,
      cricketdata_player_id: manualId,
      name,
      team,
      role,
      // Manually-added players are assumed to be announced — if not, the
      // admin can still toggle them off in the lock panel before locking.
      is_playing: true,
      is_substitute: true,
      fantasy_points: 0,
      last_updated: now,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, player: inserted })
}
