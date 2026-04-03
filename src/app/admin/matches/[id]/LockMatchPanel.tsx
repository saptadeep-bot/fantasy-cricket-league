"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"

interface Player {
  id: string
  cricketdata_player_id: string
  name: string
  team: string
  role: string
}

interface Match {
  id: string
  cricketdata_match_id: string
  team1: string
  team2: string
  status: string
  match_number: number
}

const ROLE_COLORS: Record<string, string> = {
  BAT: "bg-blue-900 text-blue-300",
  BOWL: "bg-red-900 text-red-300",
  ALL: "bg-purple-900 text-purple-300",
  WK: "bg-yellow-900 text-yellow-300",
}

export default function LockMatchPanel({
  match,
  existingPlayers,
}: {
  match: Match
  existingPlayers: Player[]
}) {
  const router = useRouter()
  const [squadPlayers, setSquadPlayers] = useState<Player[]>(existingPlayers)
  const [selectedXI, setSelectedXI] = useState<Set<string>>(
    new Set(existingPlayers.filter(p => p.id).map(p => p.cricketdata_player_id))
  )
  const [loading, setLoading] = useState(false)
  const [locking, setLocking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const alreadyLocked = match.status !== "upcoming"

  async function fetchSquad() {
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/fetch-squad`, { method: "POST" })
      const data = await res.json()
      if (data.success) {
        setSquadPlayers(data.players)
        setSelectedXI(new Set())
        setMessage(`Fetched ${data.players.length} players`)
      } else {
        setMessage(`Error: ${data.error}`)
      }
    } catch {
      setMessage("Network error")
    } finally {
      setLoading(false)
    }
  }

  function togglePlayer(playerId: string) {
    if (alreadyLocked) return
    setSelectedXI(prev => {
      const next = new Set(prev)
      if (next.has(playerId)) next.delete(playerId)
      else next.add(playerId)
      return next
    })
  }

  // Validation — use dynamic team names from API data
  const uniqueTeams = [...new Set(squadPlayers.map(p => p.team))].filter(Boolean)
  const selectedPlayers = squadPlayers.filter(p => selectedXI.has(p.cricketdata_player_id))
  const team1Players = selectedPlayers.filter(p => p.team === (uniqueTeams[0] || match.team1))
  const team2Players = selectedPlayers.filter(p => p.team === (uniqueTeams[1] || match.team2))
  const isValidXI =
    team1Players.length >= 11 && team1Players.length <= 15 &&
    team2Players.length >= 11 && team2Players.length <= 15 &&
    team1Players.length + team2Players.length >= 22

  async function lockMatch() {
    if (!isValidXI) return
    setLocking(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedPlayerIds: Array.from(selectedXI) }),
      })
      const data = await res.json()
      if (data.success) {
        setMessage("Match locked! Team selection is now open.")
        router.refresh()
      } else {
        setMessage(`Error: ${data.error}`)
      }
    } catch {
      setMessage("Network error")
    } finally {
      setLocking(false)
    }
  }

  // Group players by team name dynamically (don't rely on exact match with DB team names)
  const team1Squad = squadPlayers.filter(p => p.team === (uniqueTeams[0] || match.team1))
  const team2Squad = squadPlayers.filter(p => p.team === (uniqueTeams[1] || match.team2))

  return (
    <div className="space-y-4">
      {/* Fetch squad button */}
      {!alreadyLocked && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h3 className="font-semibold text-white mb-2">Step 1 — Fetch Squad</h3>
          <p className="text-gray-500 text-sm mb-4">
            After the toss, fetch squads and select announced players per team. Select 11–15 per team (minimum 22 total).
          </p>
          <button
            onClick={fetchSquad}
            disabled={loading}
            className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
          >
            {loading ? "Fetching..." : "Fetch Squad from API"}
          </button>
          {message && <p className="mt-2 text-sm text-gray-300">{message}</p>}
        </div>
      )}

      {/* Player selection */}
      {squadPlayers.length > 0 && (
        <>
          {[
            { team: uniqueTeams[0] || match.team1, players: team1Squad },
            { team: uniqueTeams[1] || match.team2, players: team2Squad },
          ].map(({ team, players }) => {
            const selectedCount = players.filter(p => selectedXI.has(p.cricketdata_player_id)).length
            return (
              <div key={team} className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-white">{team}</h3>
                  <span className={`text-sm font-medium ${selectedCount >= 11 && selectedCount <= 15 ? "text-green-400" : "text-yellow-400"}`}>
                    {selectedCount} selected (11–15)
                  </span>
                </div>
                <div className="space-y-2">
                  {players.map(player => {
                    const isSelected = selectedXI.has(player.cricketdata_player_id)
                    return (
                      <button
                        key={player.cricketdata_player_id}
                        onClick={() => togglePlayer(player.cricketdata_player_id)}
                        disabled={alreadyLocked}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm transition ${
                          isSelected
                            ? "bg-yellow-400/10 border border-yellow-400/50 text-white"
                            : "bg-gray-800 border border-transparent text-gray-400 hover:text-white hover:bg-gray-700"
                        } ${alreadyLocked ? "cursor-default" : "cursor-pointer"}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[player.role] || "bg-gray-700 text-gray-300"}`}>
                            {player.role}
                          </span>
                          <span>{player.name}</span>
                        </div>
                        {isSelected && <span className="text-yellow-400 text-xs">✓</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Lock button */}
          {!alreadyLocked && (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
              <h3 className="font-semibold text-white mb-2">Step 2 — Lock Match</h3>
              <p className="text-gray-500 text-sm mb-1">
                {team1Players.length}/11 from {uniqueTeams[0] || match.team1} · {team2Players.length}/11 from {uniqueTeams[1] || match.team2}
              </p>
              {!isValidXI && (
                <p className="text-red-400 text-sm mb-3">
                  Select 11–15 per team, minimum 22 total.
                  ({team1Players.length} + {team2Players.length} = {team1Players.length + team2Players.length})
                </p>
              )}
              <button
                onClick={lockMatch}
                disabled={!isValidXI || locking}
                className="bg-blue-500 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-blue-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {locking ? "Locking..." : "Lock Match & Open Team Selection"}
              </button>
              {message && <p className="mt-2 text-sm text-gray-300">{message}</p>}
            </div>
          )}

          {alreadyLocked && (
            <div className="bg-green-900/20 border border-green-800 rounded-2xl p-4 text-center">
              <p className="text-green-400 font-medium">Match is {match.status} — Playing XI confirmed</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
