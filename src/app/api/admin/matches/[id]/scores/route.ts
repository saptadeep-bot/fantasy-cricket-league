import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { computeAndSave } from "@/lib/match-scoring"
import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 60

const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY!

// ─── Scorecard fetch helpers ──────────────────────────────────────────────────

interface ScorecardResult {
  scorecard: unknown[] | null
  detail: string
  liveInProgress?: boolean
  notStarted?: boolean
}

/** Extract scorecard array from any cricapi response shape */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractScorecard(data: any): unknown[] | null {
  if (!data) return null
  if (Array.isArray(data.data?.scorecard) && data.data.scorecard.length > 0) return data.data.scorecard
  if (Array.isArray(data.data) && data.data.length > 0 && data.data[0]?.batting) return data.data
  if (data.data?.batting || data.data?.bowling) return [data.data]
  if (Array.isArray(data.data?.cards) && data.data.cards.length > 0) return data.data.cards
  if (Array.isArray(data.data?.innings) && data.data.innings.length > 0) return data.data.innings
  return null
}

async function tryScorecard(id: string): Promise<ScorecardResult> {
  // ── Attempt 1: match_scorecard endpoint ──────────────────────────────────
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKETDATA_API_KEY}&id=${id}`,
      { cache: "no-store" }
    )
    const data = await res.json()

    if (data.status === "success") {
      const sc = extractScorecard(data)
      if (sc) return { scorecard: sc, detail: "match_scorecard ok" }
      const dataKeys = data.data ? Object.keys(data.data).join(",") : "null"
      return { scorecard: null, detail: `match_scorecard empty (keys: ${dataKeys})` }
    }
  } catch {
    // fall through
  }

  // ── Attempt 2: match_info (check match state, sometimes has data) ─────────
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/match_info?apikey=${CRICKETDATA_API_KEY}&id=${id}`,
      { cache: "no-store" }
    )
    const data = await res.json()

    if (data.status === "success") {
      const matchData = data.data

      // Use truthy/falsy — cricapi returns these as booleans, strings, or numbers
      const started = matchData?.matchStarted
      const ended = matchData?.matchEnded

      if (started && !ended) {
        // Match is live — scorecard not yet available mid-innings via this API
        return {
          scorecard: null,
          detail: `live_in_progress (fantasyEnabled:${matchData.fantasyEnabled}, bbbEnabled:${matchData.bbbEnabled}, matchStarted:${started}, matchEnded:${ended})`,
          liveInProgress: true,
        }
      }

      if (!started) {
        return {
          scorecard: null,
          detail: `match_not_started (matchStarted:${started})`,
          notStarted: true,
        }
      }

      // started && ended — match complete but scorecard unavailable
      const sc = extractScorecard(data)
      if (sc) return { scorecard: sc, detail: "match_info ok" }

      const dataKeys = matchData ? Object.keys(matchData).join(",") : "null"
      return { scorecard: null, detail: `match_info empty (matchStarted:${started}, matchEnded:${ended}, keys: ${dataKeys})` }
    }
    return { scorecard: null, detail: `match_info failed: ${data.reason || data.message || data.status}` }
  } catch (e) {
    return { scorecard: null, detail: `network error: ${String(e)}` }
  }
}

interface FetchResult {
  updated: number
  total: number
  remapped: number
  autoAdded: number
  missed: string[]
  liveInProgress?: boolean
  notStarted?: boolean
}

async function findLiveMatchId(team1: string, team2: string): Promise<string | null> {
  const [p0, p1] = await Promise.all([
    fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=0`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
    fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=25`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
  ])

  const liveMatches: { id: string; name?: string; teams?: string[] }[] = [
    ...(p0.data || []),
    ...(p1.data || []),
  ]

  const tokens = (name: string) => [
    name.toLowerCase(),
    name.split(" ").pop()!.toLowerCase(),
    name.split(" ")[0].toLowerCase(),
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

async function fetchAndSaveScores(matchId: string, cricketdataMatchId: string): Promise<FetchResult> {
  // Step 1: try the stored ID
  const r1 = await tryScorecard(cricketdataMatchId)
  let scorecard = r1.scorecard
  let lastDetail = `stored ID (${cricketdataMatchId}): ${r1.detail}`
  let liveInProgress = r1.liveInProgress ?? false
  let notStarted = r1.notStarted ?? false

  // Step 2: if no scorecard and not definitively live/unstarted, search currentMatches
  if (!scorecard && !liveInProgress && !notStarted) {
    const { data: matchRow } = await supabaseAdmin
      .from("matches")
      .select("team1, team2")
      .eq("id", matchId)
      .single()

    if (matchRow) {
      const foundId = await findLiveMatchId(matchRow.team1, matchRow.team2)
      lastDetail += ` | currentMatches lookup: ${foundId ?? "not found"}`

      if (foundId) {
        if (foundId !== cricketdataMatchId) {
          await supabaseAdmin
            .from("matches")
            .update({ cricketdata_match_id: foundId })
            .eq("id", matchId)
        }
        const r2 = await tryScorecard(foundId)
        scorecard = r2.scorecard
        liveInProgress = r2.liveInProgress ?? false
        notStarted = r2.notStarted ?? false
        lastDetail += ` | retry (${foundId}): ${r2.detail}`
      }
    }
  }

  if (!scorecard) {
    if (liveInProgress) return { updated: 0, total: 0, remapped: 0, autoAdded: 0, missed: [], liveInProgress: true }
    if (notStarted) return { updated: 0, total: 0, remapped: 0, autoAdded: 0, missed: [], notStarted: true }
    throw new Error(`Scorecard unavailable. Debug: ${lastDetail}`)
  }

  const result = await computeAndSave(matchId, scorecard)
  return result
}

// ─── DB read helpers ──────────────────────────────────────────────────────────
async function readPlayersFromDb(matchId: string) {
  const { data } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name, team, role, fantasy_points, last_updated")
    .eq("match_id", matchId)
    .order("fantasy_points", { ascending: false })
  return data || []
}

async function readTeamsFromDb(matchId: string) {
  const { data } = await supabaseAdmin
    .from("teams")
    .select("id, user_id, player_ids, captain_id, vice_captain_id, users(id, name)")
    .eq("match_id", matchId)
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

    if (result.liveInProgress) {
      const players = await readPlayersFromDb(id)
      return NextResponse.json({
        success: false,
        liveInProgress: true,
        error: "Match is currently live — player scores are updated by cricapi after each innings completes. Points will appear automatically once an innings ends.",
        players,
      })
    }

    if (result.notStarted) {
      const players = await readPlayersFromDb(id)
      return NextResponse.json({
        success: false,
        notStarted: true,
        error: "Match hasn't started yet. Scores will be available once the match begins.",
        players,
      })
    }

    const players = await readPlayersFromDb(id)
    const msg = [
      `Updated ${result.updated}/${result.total} player scores`,
      result.remapped > 0 ? `${result.remapped} ID remapped` : "",
      result.autoAdded > 0 ? `${result.autoAdded} new player(s) added (${result.missed.length === 0 ? "OK" : result.missed.join(", ")})` : "",
    ].filter(Boolean).join(". ")
    return NextResponse.json({ success: true, players, ...result, message: msg })
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
    const [players, teams] = await Promise.all([readPlayersFromDb(id), readTeamsFromDb(id)])
    return NextResponse.json({ players, teams })
  }

  // Auto-poll: fetch from API if data is stale (>45 seconds)
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
    const isStale = !lastUpdated || lastUpdated < new Date(Date.now() - 45_000)

    if (isStale) {
      try {
        await fetchAndSaveScores(id, match.cricketdata_match_id)
        // Any result (including liveInProgress/notStarted) is fine — never set fetchError during live
      } catch {
        // Match is live per our DB — API failures mid-innings are expected.
        // Silently swallow the error and keep polling every 60s.
        // Scores will appear automatically once cricapi has the scorecard ready.
      }
    }
  }

  const [players, teams] = await Promise.all([readPlayersFromDb(id), readTeamsFromDb(id)])

  const hasScores = players.some((p: { fantasy_points?: number }) => (p.fantasy_points || 0) > 0)
  return NextResponse.json({
    players,
    teams,
    ...(fetchError && !hasScores ? { fetchError } : {}),
  })
}
