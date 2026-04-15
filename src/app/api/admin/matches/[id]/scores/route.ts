import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"
import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

// ─── Name matching ────────────────────────────────────────────────────────────
// Cricapi uses abbreviated names in scorecards ("V Kohli") but full names in
// squad ("Virat Kohli"). We need fuzzy matching to link them.
function norm(s: string) {
  return s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()
}

function namesMatch(a: string, b: string): boolean {
  const na = norm(a)
  const nb = norm(b)
  if (na === nb) return true

  const pa = na.split(" ")
  const pb = nb.split(" ")

  // Last word (surname) must match exactly
  if (pa[pa.length - 1] !== pb[pb.length - 1]) return false

  const fa = pa[0]
  const fb = pb[0]

  // First names match, or one is just the initial of the other
  if (fa === fb) return true
  if (fa.length === 1 && fb.startsWith(fa)) return true
  if (fb.length === 1 && fa.startsWith(fb)) return true

  return false
}

// ─── computeAndSave ───────────────────────────────────────────────────────────
async function computeAndSave(matchId: string, scorecard: unknown[]) {
  const pointsMap = calculateFantasyPoints(scorecard)
  if (pointsMap.size === 0) return { updated: 0, total: 0, remapped: 0, missed: [] as string[] }

  const { data: dbPlayers } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name")
    .eq("match_id", matchId)

  const dbList = (dbPlayers || []).map(p => ({
    id: p.cricketdata_player_id,
    name: p.name,
  }))
  const dbIds = new Set(dbList.map(p => p.id))

  const now = new Date().toISOString()
  const directUpdates: Array<{ id: string; points: number }> = []
  const idRemaps: Array<{ oldId: string; newId: string; fantasyPoints: number }> = []
  const nameMissed: string[] = []

  for (const [playerId, pts] of pointsMap.entries()) {
    const fantasyPoints = Math.round(pts.total * 10) / 10

    if (dbIds.has(playerId)) {
      // Perfect ID match — direct update
      directUpdates.push({ id: playerId, points: fantasyPoints })
    } else {
      // Try fuzzy name match (handles "V Kohli" ↔ "Virat Kohli" etc.)
      const match = dbList.find(p => namesMatch(pts.name, p.name))
      if (match) {
        idRemaps.push({ oldId: match.id, newId: playerId, fantasyPoints })
      } else {
        nameMissed.push(pts.name)
      }
    }
  }

  // Parallel direct updates
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

  // Name-based remaps: correct stored ID and save points
  let remapped = 0
  for (const { oldId, newId, fantasyPoints } of idRemaps) {
    const { error } = await supabaseAdmin
      .from("match_players")
      .update({ cricketdata_player_id: newId, fantasy_points: fantasyPoints, last_updated: now })
      .eq("match_id", matchId)
      .eq("cricketdata_player_id", oldId)
    if (!error) remapped++
  }

  // Repair team player_ids / captain / vc that used old IDs
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
          playerIds = playerIds.map(pid => (pid === oldId ? newId : pid))
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

// ─── Scorecard fetch helpers ──────────────────────────────────────────────────
async function tryScorecard(id: string): Promise<unknown[] | null> {
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${id}`,
      { cache: "no-store" }
    )
    const data = await res.json()
    if (data.status === "success") {
      const sc = data.data?.scorecard ?? []
      return sc.length > 0 ? sc : null
    }
  } catch {
    // network error — treat as no data
  }
  return null
}

async function findLiveMatchId(team1: string, team2: string): Promise<string | null> {
  // Fetch two pages of currentMatches in parallel (covers up to 50 matches)
  const [p0, p1] = await Promise.all([
    fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=0`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
    fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=25`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
  ])

  const liveMatches: { id: string; name?: string; teams?: string[] }[] = [
    ...(p0.data || []),
    ...(p1.data || []),
  ]

  // Build multiple name tokens for each team to maximise match chance
  const tokens = (name: string) => [
    name.toLowerCase(),
    name.split(" ").pop()!.toLowerCase(),   // last word  e.g. "Indians"
    name.split(" ")[0].toLowerCase(),        // first word e.g. "Mumbai"
  ]

  const t1 = tokens(team1)
  const t2 = tokens(team2)

  const hits = (haystack: string, toks: string[]) =>
    toks.some(t => haystack.toLowerCase().includes(t))

  const found = liveMatches.find(m => {
    const haystack = [...(m.teams || []), m.name || ""].join(" ")
    return hits(haystack, t1) && hits(haystack, t2)
  })

  return found?.id ?? null
}

async function fetchAndSaveScores(matchId: string, cricketdataMatchId: string) {
  // Step 1: try the stored ID
  let scorecard = await tryScorecard(cricketdataMatchId)

  // Step 2: if no scorecard, search currentMatches for the correct live ID
  if (!scorecard) {
    const { data: matchRow } = await supabaseAdmin
      .from("matches")
      .select("team1, team2")
      .eq("id", matchId)
      .single()

    if (matchRow) {
      const foundId = await findLiveMatchId(matchRow.team1, matchRow.team2)

      if (foundId) {
        // Always persist whatever ID we found (even if same — confirms it's current)
        if (foundId !== cricketdataMatchId) {
          await supabaseAdmin
            .from("matches")
            .update({ cricketdata_match_id: foundId })
            .eq("id", matchId)
        }
        scorecard = await tryScorecard(foundId)
      }
    }
  }

  if (!scorecard) {
    throw new Error("Scorecard not available yet — try again in a moment.")
  }

  return await computeAndSave(matchId, scorecard)
}

// ─── DB read helper ───────────────────────────────────────────────────────────
async function readPlayersFromDb(matchId: string) {
  const { data } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name, team, role, fantasy_points, last_updated")
    .eq("match_id", matchId)
    .order("fantasy_points", { ascending: false })
  return data || []
}

// ─── Admin POST: force-fetch ──────────────────────────────────────────────────
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

// ─── Public GET ───────────────────────────────────────────────────────────────
// ?refresh=1 / ?force=true → instant DB read (participant Refresh button)
// (no params) → auto-poll: fetch from API if stale, return DB data
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const isParticipantRefresh =
    url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "true"

  if (isParticipantRefresh) {
    const players = await readPlayersFromDb(id)
    return NextResponse.json({ players })
  }

  // Auto-poll: fetch from API if data is >90 seconds stale
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
        fetchError = String(err).replace(/^Error:\s*/, "")
      }
    }
  }

  const players = await readPlayersFromDb(id)

  // Only surface API errors when there are no scores yet — once scores are
  // showing, a transient API blip shouldn't alarm participants
  const hasScores = players.some(p => (p.fantasy_points || 0) > 0)
  return NextResponse.json({
    players,
    ...(fetchError && !hasScores ? { fetchError } : {}),
  })
}
