import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"
import { NextRequest, NextResponse } from "next/server"

// Give Vercel up to 60 seconds for external API calls
export const maxDuration = 60

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

async function computeAndSave(matchId: string, scorecard: unknown[]) {
  const pointsMap = calculateFantasyPoints(scorecard)
  if (pointsMap.size === 0) return { updated: 0, total: 0, remapped: 0, missed: [] as string[] }

  // Load all current match_players from DB in one query
  const { data: dbPlayers } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name")
    .eq("match_id", matchId)

  const nameToDbId = new Map<string, string>()
  const dbIds = new Set<string>()
  for (const p of (dbPlayers || [])) {
    const key = p.name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()
    nameToDbId.set(key, p.cricketdata_player_id)
    dbIds.add(p.cricketdata_player_id)
  }

  const now = new Date().toISOString()
  const idRemaps: Array<{ oldId: string; newId: string; fantasyPoints: number }> = []
  const directUpdates: Array<{ id: string; points: number }> = []
  const nameMissed: string[] = []

  for (const [playerId, pts] of pointsMap.entries()) {
    const fantasyPoints = Math.round(pts.total * 10) / 10
    const normalizedName = pts.name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()

    if (dbIds.has(playerId)) {
      directUpdates.push({ id: playerId, points: fantasyPoints })
    } else {
      const dbId = nameToDbId.get(normalizedName)
      if (dbId) {
        idRemaps.push({ oldId: dbId, newId: playerId, fantasyPoints })
      } else {
        nameMissed.push(pts.name)
      }
    }
  }

  // Run all direct updates in parallel (no unique constraint needed — just WHERE clauses)
  const directResults = await Promise.all(
    directUpdates.map(({ id, points }) =>
      supabaseAdmin
        .from("match_players")
        .update({ fantasy_points: points, last_updated: now })
        .eq("match_id", matchId)
        .eq("cricketdata_player_id", id)
    )
  )
  const updated = directResults.filter(r => !r.error).length

  // Name-based remaps: fix the stored player ID AND update points
  let remapped = 0
  for (const { oldId, newId, fantasyPoints } of idRemaps) {
    const { error } = await supabaseAdmin
      .from("match_players")
      .update({ cricketdata_player_id: newId, fantasy_points: fantasyPoints, last_updated: now })
      .eq("match_id", matchId)
      .eq("cricketdata_player_id", oldId)
    if (!error) remapped++
  }

  // Fix captain/vc/player_ids in teams that referenced remapped IDs
  if (idRemaps.length > 0) {
    const { data: teamsData } = await supabaseAdmin
      .from("teams")
      .select("id, player_ids, captain_id, vice_captain_id")
      .eq("match_id", matchId)

    for (const team of (teamsData || [])) {
      let changed = false
      let playerIds: string[] = team.player_ids || []
      let captainId: string = team.captain_id
      let vcId: string = team.vice_captain_id

      for (const { oldId, newId } of idRemaps) {
        if (playerIds.includes(oldId)) {
          playerIds = playerIds.map(pid => pid === oldId ? newId : pid)
          changed = true
        }
        if (captainId === oldId) { captainId = newId; changed = true }
        if (vcId === oldId) { vcId = newId; changed = true }
      }

      if (changed) {
        await supabaseAdmin
          .from("teams")
          .update({ player_ids: playerIds, captain_id: captainId, vice_captain_id: vcId })
          .eq("id", team.id)
      }
    }
  }

  return { updated: updated + remapped, total: pointsMap.size, remapped, missed: nameMissed }
}

async function fetchAndSaveScores(matchId: string, cricketdataMatchId: string) {
  let resolvedId = cricketdataMatchId

  const res = await fetch(
    `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${resolvedId}`,
    { cache: "no-store" }
  )
  const data = await res.json()

  if (data.status !== "success") {
    const reason = (data.reason || data.message || "").toLowerCase()

    if (reason.includes("not found") || reason.includes("invalid")) {
      // Match ID may differ between scheduled and live — auto-correct
      const { data: matchRow } = await supabaseAdmin
        .from("matches")
        .select("team1, team2")
        .eq("id", matchId)
        .single()

      if (matchRow) {
        const liveRes = await fetch(
          `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=0`,
          { cache: "no-store" }
        )
        const liveData = await liveRes.json()
        const liveMatches: { id: string; teams: string[] }[] = liveData.data || []

        const t1 = matchRow.team1.split(" ").pop()!.toLowerCase()
        const t2 = matchRow.team2.split(" ").pop()!.toLowerCase()
        const found = liveMatches.find(m =>
          m.teams?.some((t: string) => t.toLowerCase().includes(t1)) &&
          m.teams?.some((t: string) => t.toLowerCase().includes(t2))
        )

        if (found && found.id !== cricketdataMatchId) {
          await supabaseAdmin
            .from("matches")
            .update({ cricketdata_match_id: found.id })
            .eq("id", matchId)
          resolvedId = found.id

          const retryRes = await fetch(
            `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${resolvedId}`,
            { cache: "no-store" }
          )
          const retryData = await retryRes.json()
          if (retryData.status === "success") {
            const scorecard = retryData.data?.scorecard || []
            if (scorecard.length === 0) throw new Error("Scorecard is empty — match may just be starting.")
            return await computeAndSave(matchId, scorecard)
          }
          throw new Error("Scorecard unavailable even after ID correction.")
        }
      }
      throw new Error("Scorecard not available yet. Match may still be starting.")
    }
    throw new Error(`Cricket API error: ${data.reason || data.message || "Unknown"}`)
  }

  const scorecard = data.data?.scorecard || []
  if (scorecard.length === 0) {
    throw new Error("Scorecard empty — match may not have started yet.")
  }

  return await computeAndSave(matchId, scorecard)
}

async function readPlayersFromDb(matchId: string) {
  const { data: players } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name, team, role, fantasy_points, last_updated")
    .eq("match_id", matchId)
    .order("fantasy_points", { ascending: false })
  return players || []
}

// ─── Admin POST: force-fetch from Cricket API ────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("cricketdata_match_id, status")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })

  try {
    const result = await fetchAndSaveScores(id, match.cricketdata_match_id)
    const players = await readPlayersFromDb(id)
    return NextResponse.json({ success: true, players, ...result })
  } catch (err) {
    return NextResponse.json({ error: String(err).replace(/^Error:\s*/, "") }, { status: 400 })
  }
}

// ─── Public GET ──────────────────────────────────────────────────────────────
// ?refresh=1  → participant pressed Refresh: reads DB only (always fast)
// ?force=true → legacy alias for ?refresh=1
// (no params) → auto-poll: fetches from API when stale, then returns DB data
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const isParticipantRefresh =
    url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "true"

  if (isParticipantRefresh) {
    // Instant DB read — no external API call, never times out
    const players = await readPlayersFromDb(id)
    return NextResponse.json({ players })
  }

  // Auto-poll path: fetch from API if data is >90 seconds stale
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("status, cricketdata_match_id")
    .eq("id", id)
    .single()

  let fetchError: string | null = null

  if (match?.status === "live" && match?.cricketdata_match_id) {
    const { data: lastPlayer } = await supabaseAdmin
      .from("match_players")
      .select("last_updated")
      .eq("match_id", id)
      .not("last_updated", "is", null)
      .order("last_updated", { ascending: false })
      .limit(1)
      .single()

    const lastUpdated = lastPlayer?.last_updated ? new Date(lastPlayer.last_updated) : null
    const isStale = !lastUpdated || lastUpdated < new Date(Date.now() - 90_000)

    if (isStale) {
      try {
        await fetchAndSaveScores(id, match.cricketdata_match_id)
      } catch (err) {
        // Capture the error so the client can display it
        fetchError = String(err).replace(/^Error:\s*/, "")
      }
    }
  }

  const players = await readPlayersFromDb(id)
  return NextResponse.json({ players, ...(fetchError ? { fetchError } : {}) })
}
