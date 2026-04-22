"use client"
import { useState, useEffect, useCallback } from "react"

// Shows "Updated Xm ago" and ticks every 30s — turns red if >10 min stale
function ScoreAge({ updatedAt }: { updatedAt: Date }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const diffMs = Date.now() - updatedAt.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const label = diffMin < 1 ? "just now" : `${diffMin}m ago`
  const isStale = diffMin >= 10

  return (
    <span className={`text-xs ${isStale ? "text-red-400" : "text-gray-500"}`}>
      {isStale ? "⚠ " : ""}Scores: {label}
    </span>
  )
}

const ROLE_COLORS: Record<string, string> = {
  BAT: "bg-blue-900 text-blue-300",
  BOWL: "bg-red-900 text-red-300",
  ALL: "bg-purple-900 text-purple-300",
  WK: "bg-yellow-900 text-yellow-300",
}

interface Player {
  cricketdata_player_id: string
  name: string
  team: string
  role: string
  fantasy_points: number
  last_updated?: string
}

interface Team {
  id: string
  user_id: string
  player_ids: string[]
  captain_id: string
  vice_captain_id: string
  users?: { id: string; name: string }
}

interface Result {
  user_id: string
  rank: number
  final_points: number
  prize_won: number
  is_settled?: boolean
  users?: { name: string }
}

interface Match {
  id: string
  status: string
  match_number: number
  team1: string
  team2: string
  base_prize: number
  rollover_added?: number
  result_announcement?: string
}

export default function LiveMatchView({
  match,
  teams: initialTeams,
  players,
  results,
  currentUserId,
}: {
  match: Match
  teams: Team[]
  players: Player[]
  results: Result[]
  myTeam: Team | null   // kept for API compat, derived from liveTeams below
  currentUserId: string
}) {
  const [livePlayers, setLivePlayers] = useState<Player[]>(players)
  const [liveTeams, setLiveTeams] = useState<Team[]>(initialTeams)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [activeTab, setActiveTab] = useState<"scores" | "myteam" | "allteams">("scores")

  // Always derive myTeam from live teams state so it updates when IDs change
  const myTeam = liveTeams.find(t => t.user_id === currentUserId) || null

  // Build points map from live player data
  const pointsMap = Object.fromEntries(
    livePlayers.map(p => [p.cricketdata_player_id, p.fantasy_points || 0])
  )

  // Compute live score for a team
  function computeTeamScore(team: Team): number {
    if (!team?.player_ids) return 0
    return team.player_ids.reduce((sum: number, pid: string) => {
      const pts = pointsMap[pid] || 0
      const mult = pid === team.captain_id ? 2 : pid === team.vice_captain_id ? 1.5 : 1
      return sum + pts * mult
    }, 0)
  }

  // Sort teams by live score
  const rankedTeams = [...liveTeams]
    .map(t => ({ ...t, liveScore: Math.round(computeTeamScore(t) * 10) / 10 }))
    .sort((a, b) => b.liveScore - a.liveScore)

  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [apiLastUpdated, setApiLastUpdated] = useState<Date | null>(null)
  const [debugInfo, setDebugInfo] = useState<string | null>(null)
  const [pollTick, setPollTick] = useState<Date | null>(null)

  // Derive API last-updated time from the player data (when DB was last written by API)
  useEffect(() => {
    const timestamps = livePlayers
      .map(p => p.last_updated ? new Date(p.last_updated).getTime() : 0)
      .filter(t => t > 0)
    if (timestamps.length > 0) {
      setApiLastUpdated(new Date(Math.max(...timestamps)))
    }
  }, [livePlayers])

  // Auto-poll: triggers API fetch on server if >45s stale, then returns DB data.
  // cache:no-store + ?t=cache-buster are both needed — without them, browsers
  // (especially mobile Safari) heuristically cache the GET response and replay
  // it for minutes without ever hitting the server.  That manifested on
  // 2026-04-20 as fantasy points frozen for 15+ min on the participant view
  // while admin POST refresh worked fine (POST is never browser-cached).
  const fetchLiveScores = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/scores?t=${Date.now()}`, {
        cache: "no-store",
      })
      const data = await res.json()
      if (data.players) {
        setLivePlayers(data.players)
        setLastUpdated(new Date())
      }
      if (data.teams) setLiveTeams(data.teams)
      if (data.fetchError) {
        setPollError(data.fetchError)
      } else {
        setPollError(null)
      }
      setPollTick(new Date())
      if (data._debug) {
        const d = data._debug
        const parts: string[] = []
        parts.push(`status:${d.matchStatus}`)
        if (d.fetchAttempted) {
          if (d.fetchError) parts.push(`err:${String(d.fetchError).slice(0, 120)}`)
          else if (d.fetchResult?.liveInProgress) parts.push(`live_in_progress`)
          else if (d.fetchResult?.notStarted) parts.push(`not_started`)
          else {
            const src = d.fetchResult?.source ? ` src:${String(d.fetchResult.source).slice(0, 40)}` : ""
            parts.push(`fetched:${d.fetchResult?.updated ?? "?"}/${d.fetchResult?.total ?? "?"}${src}`)
          }
          // Always append lastDetail when present — it's the only way to
          // diagnose live_in_progress / "both sources empty" situations
          // without firing the admin POST.
          if (d.lastDetail) parts.push(String(d.lastDetail).slice(0, 300))
        } else {
          parts.push("no_fetch")
        }
        setDebugInfo(parts.join(" | "))
      }
    } catch {
      // Network error — keep retrying silently
    }
  }, [match.id])

  // Manual refresh — reads latest from DB instantly (no API call, never fails)
  const manualRefresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/scores?refresh=1&t=${Date.now()}`, {
        cache: "no-store",
      })
      const data = await res.json()
      if (data.error) {
        setRefreshError(data.error)
      } else {
        if (data.players) setLivePlayers(data.players)
        if (data.teams) setLiveTeams(data.teams)
        setLastUpdated(new Date())
      }
    } catch {
      setRefreshError("Network error. Try again.")
    } finally {
      setRefreshing(false)
    }
  }, [match.id])

  useEffect(() => {
    if (match.status === "live") {
      fetchLiveScores()
      // Poll every 60 seconds — server only calls API if data is stale
      const interval = setInterval(fetchLiveScores, 60 * 1000)
      return () => clearInterval(interval)
    }
  }, [match.status, fetchLiveScores])

  const tabs = [
    { key: "scores", label: "Live Scores" },
    { key: "myteam", label: "My Team" },
    { key: "allteams", label: "All Teams" },
  ]

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-900 p-1 rounded-xl">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as "scores" | "myteam" | "allteams")}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${
              activeTab === tab.key
                ? "bg-yellow-400 text-gray-900"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* SCORES TAB */}
      {activeTab === "scores" && (
        <div className="space-y-3">
          {match.status === "completed" && results.length > 0 ? (
            <>
              <h2 className="text-white font-semibold">Final Results</h2>
              {results.map((r: Result) => (
                <div key={r.user_id} className={`bg-gray-900 border rounded-2xl p-4 flex items-center justify-between ${
                  r.user_id === currentUserId ? "border-yellow-400/50" : "border-gray-800"
                }`}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">
                      {r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`}
                    </span>
                    <div>
                      <p className="text-white font-medium">{r.users?.name}</p>
                      <p className="text-gray-500 text-sm">{r.final_points} pts</p>
                    </div>
                  </div>
                  <div className="text-right">
                    {r.prize_won > 0 ? (
                      <p className="text-yellow-400 font-bold text-lg">+₹{r.prize_won}</p>
                    ) : (
                      <p className="text-gray-600 text-sm">No prize</p>
                    )}
                    {r.is_settled && <p className="text-green-500 text-xs">Settled ✓</p>}
                  </div>
                </div>
              ))}
              {match.result_announcement && (
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
                  <p className="text-gray-400 text-sm">📢 {match.result_announcement}</p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-white font-semibold">
                  {match.status === "live" ? "Live Leaderboard" : "Leaderboard"}
                </h2>
                {match.status === "live" && (
                  <div className="text-right">
                    <div className="flex items-center gap-2">
                      {apiLastUpdated && (
                        <ScoreAge updatedAt={apiLastUpdated} />
                      )}
                      <button
                        onClick={manualRefresh}
                        disabled={refreshing}
                        className="bg-yellow-400/10 border border-yellow-400/40 text-yellow-400 text-xs font-semibold px-3 py-1 rounded-lg hover:bg-yellow-400/20 transition disabled:opacity-50"
                      >
                        {refreshing ? "Loading…" : "↻ Refresh"}
                      </button>
                    </div>
                    {refreshError && (
                      <p className="text-red-400 text-xs mt-1">{refreshError}</p>
                    )}
                    {pollError && !refreshError && (
                      <p className="text-orange-400 text-xs mt-1">⚠ {pollError}</p>
                    )}
                    {debugInfo && (
                      <p className="text-gray-600 text-[10px] mt-1 font-mono break-all text-right">
                        {pollTick && `poll ${pollTick.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" })} · `}{debugInfo}
                      </p>
                    )}
                  </div>
                )}
              </div>
              {rankedTeams.length === 0 ? (
                <p className="text-gray-500 text-sm">No teams submitted yet.</p>
              ) : (
                <>
                  {/* Show info banner when match is live but no scores yet */}
                  {match.status === "live" && rankedTeams.every(t => t.liveScore === 0) && !pollError && (
                    <div className="bg-blue-950 border border-blue-800 rounded-xl px-4 py-2.5 text-blue-300 text-xs">
                      🏏 Match in progress — fantasy points will appear once the first innings gets underway. This page refreshes automatically.
                    </div>
                  )}
                  {rankedTeams.map((team, idx) => (
                    <div key={team.id} className={`bg-gray-900 border rounded-2xl p-4 flex items-center justify-between ${
                      team.user_id === currentUserId ? "border-yellow-400/50" : "border-gray-800"
                    }`}>
                      <div className="flex items-center gap-3">
                        <span className="text-xl font-bold text-gray-600">#{idx + 1}</span>
                        <div>
                          <p className="text-white font-medium">{team.users?.name}</p>
                          {team.user_id === currentUserId && (
                            <span className="text-xs text-yellow-400">You</span>
                          )}
                        </div>
                      </div>
                      <p className="text-white font-bold text-lg">{team.liveScore} pts</p>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* MY TEAM TAB */}
      {activeTab === "myteam" && (
        <div>
          {myTeam ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-white font-semibold">Your Team</h2>
                <p className="text-yellow-400 font-bold">
                  {Math.round(computeTeamScore(myTeam) * 10) / 10} pts
                </p>
              </div>
              {myTeam.player_ids?.map((pid: string) => {
                const player = livePlayers.find(p => p.cricketdata_player_id === pid)
                if (!player) return null
                const isCaptain = pid === myTeam.captain_id
                const isVc = pid === myTeam.vice_captain_id
                const mult = isCaptain ? 2 : isVc ? 1.5 : 1
                const pts = (player.fantasy_points || 0) * mult
                return (
                  <div key={pid} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[player.role] || "bg-gray-800 text-gray-300"}`}>
                        {player.role}
                      </span>
                      <span className="text-white text-sm">{player.name}</span>
                      {isCaptain && <span className="text-xs bg-yellow-400 text-gray-900 px-1.5 rounded font-bold">C</span>}
                      {isVc && <span className="text-xs bg-gray-400 text-gray-900 px-1.5 rounded font-bold">VC</span>}
                    </div>
                    <div className="text-right">
                      <p className="text-white font-medium text-sm">{Math.round(pts * 10) / 10}</p>
                      {mult > 1 && <p className="text-gray-500 text-xs">{player.fantasy_points} × {mult}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">You haven&apos;t submitted a team for this match.</p>
              {match.status === "upcoming" && (
                <a href={`/match/${match.id}/team`} className="mt-3 inline-block bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm">
                  Pick Team →
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* ALL TEAMS TAB */}
      {activeTab === "allteams" && (
        <div className="space-y-4">
          {match.status !== "completed" && match.status !== "live" ? (
            <p className="text-gray-500 text-sm text-center py-4">Other teams are revealed once the match goes live.</p>
          ) : (
            rankedTeams.map(team => (
              <div key={team.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-white font-semibold">{team.users?.name}</p>
                  <p className="text-yellow-400 font-bold">{team.liveScore} pts</p>
                </div>
                <div className="space-y-1.5">
                  {team.player_ids?.map((pid: string) => {
                    const player = livePlayers.find(p => p.cricketdata_player_id === pid)
                    if (!player) return null
                    const isCaptain = pid === team.captain_id
                    const isVc = pid === team.vice_captain_id
                    const mult = isCaptain ? 2 : isVc ? 1.5 : 1
                    return (
                      <div key={pid} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-1 py-0.5 rounded ${ROLE_COLORS[player.role] || "bg-gray-800 text-gray-300"}`}>{player.role}</span>
                          <span className="text-gray-300">{player.name}</span>
                          {isCaptain && <span className="text-xs text-yellow-400 font-bold">(C)</span>}
                          {isVc && <span className="text-xs text-gray-400 font-bold">(VC)</span>}
                        </div>
                        <span className="text-gray-400">{Math.round((player.fantasy_points || 0) * mult * 10) / 10}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
