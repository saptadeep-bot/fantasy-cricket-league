"use client"
import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"

interface Player {
  id: string
  cricketdata_player_id: string
  name: string
  team: string
  role: "BAT" | "BOWL" | "ALL" | "WK"
  fantasy_points: number
}

interface Match {
  id: string
  team1: string
  team2: string
  status: string
}

const ROLE_COLORS: Record<string, string> = {
  BAT: "bg-blue-900 text-blue-300",
  BOWL: "bg-red-900 text-red-300",
  ALL: "bg-purple-900 text-purple-300",
  WK: "bg-yellow-900 text-yellow-300",
}

type FilterKey = "ALL" | "BAT" | "BOWL" | "WK" | "ALL_ROLE" | "team1" | "team2"

export default function TeamPicker({
  matchId,
  match,
  players,
  existingTeam,
}: {
  matchId: string
  match: Match
  players: Player[]
  existingTeam: any
}) {
  const router = useRouter()

  const [selected, setSelected] = useState<Set<string>>(
    new Set(existingTeam?.player_ids || [])
  )
  const [captain, setCaptain] = useState<string>(existingTeam?.captain_id || "")
  const [vc, setVc] = useState<string>(existingTeam?.vice_captain_id || "")
  const [filter, setFilter] = useState<FilterKey>("ALL")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Computed stats
  const selectedPlayers = useMemo(() => players.filter(p => selected.has(p.cricketdata_player_id)), [selected, players])
  const teamCounts = useMemo(() => {
    const t: Record<string, number> = {}
    selectedPlayers.forEach(p => { t[p.team] = (t[p.team] || 0) + 1 })
    return t
  }, [selectedPlayers])

  const filteredPlayers = useMemo(() => {
    if (filter === "team1") return players.filter(p => p.team === match.team1)
    if (filter === "team2") return players.filter(p => p.team === match.team2)
    if (filter === "ALL") return players
    if (filter === "ALL_ROLE") return players.filter(p => p.role === "ALL")
    return players.filter(p => p.role === filter)
  }, [filter, players, match])

  function togglePlayer(playerId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(playerId)) {
        next.delete(playerId)
        if (captain === playerId) setCaptain("")
        if (vc === playerId) setVc("")
      } else {
        if (next.size >= 11) {
          setError("You can only select 11 players")
          return prev
        }
        next.add(playerId)
      }
      setError(null)
      return next
    })
  }

  function handleCaptain(playerId: string) {
    if (!selected.has(playerId)) return
    if (vc === playerId) setVc("")
    setCaptain(playerId)
  }

  function handleVc(playerId: string) {
    if (!selected.has(playerId)) return
    if (captain === playerId) setCaptain("")
    setVc(playerId)
  }

  // Validation
  const validationErrors: string[] = []
  if (selected.size !== 11) validationErrors.push(`Select ${11 - selected.size} more player${11 - selected.size !== 1 ? "s" : ""}`)
  const team1Count = teamCounts[match.team1] || 0
  const team2Count = teamCounts[match.team2] || 0
  if (selected.size === 11 && (team1Count < 4 || team2Count < 4)) validationErrors.push("Min 4 from each team")
  if (!captain) validationErrors.push("Pick a captain")
  if (!vc) validationErrors.push("Pick a vice-captain")
  const isValid = validationErrors.length === 0

  async function saveTeam() {
    if (!isValid) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/match/${matchId}/team`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerIds: Array.from(selected),
          captainId: captain,
          viceCaptainId: vc,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setSaved(true)
        setTimeout(() => router.push("/"), 1500)
      } else {
        setError(data.error)
      }
    } catch {
      setError("Network error. Try again.")
    } finally {
      setSaving(false)
    }
  }

  const filterTabs: { key: FilterKey; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "WK", label: "WK" },
    { key: "BAT", label: "BAT" },
    { key: "BOWL", label: "BOWL" },
    { key: "ALL_ROLE", label: "ALL" },
    { key: "team1", label: match.team1.slice(0, 3).toUpperCase() },
    { key: "team2", label: match.team2.slice(0, 3).toUpperCase() },
  ]

  return (
    <div className="space-y-4">
      {/* Team balance indicators */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          {[match.team1, match.team2].map(team => {
            const count = teamCounts[team] || 0
            const ok = count >= 4
            return (
              <div key={team} className={`rounded-xl p-3 text-center ${ok ? "bg-green-900/30 border border-green-800" : "bg-gray-800 border border-gray-700"}`}>
                <p className={`text-xs font-semibold truncate ${ok ? "text-green-400" : "text-gray-500"}`}>{team}</p>
                <p className={`text-2xl font-bold ${ok ? "text-white" : "text-gray-600"}`}>{count}</p>
                <p className={`text-xs ${ok ? "text-green-600" : "text-gray-600"}`}>{ok ? "✓" : "min 4"}</p>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-center">
          <span className={`text-sm font-bold ${selected.size === 11 ? "text-green-400" : "text-yellow-400"}`}>
            {selected.size}/11 selected
          </span>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {filterTabs.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
              filter === key
                ? "bg-yellow-400 text-gray-900"
                : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Player list */}
      <div className="space-y-2">
        {filteredPlayers.map(player => {
          const isSelected = selected.has(player.cricketdata_player_id)
          const isCaptain = captain === player.cricketdata_player_id
          const isVc = vc === player.cricketdata_player_id

          return (
            <div
              key={player.cricketdata_player_id}
              className={`rounded-xl border transition ${
                isSelected
                  ? "bg-yellow-400/5 border-yellow-400/40"
                  : "bg-gray-900 border-gray-800"
              }`}
            >
              <div className="flex items-center gap-3 p-3">
                {/* Select checkbox */}
                <button
                  onClick={() => togglePlayer(player.cricketdata_player_id)}
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition ${
                    isSelected
                      ? "bg-yellow-400 border-yellow-400 text-gray-900"
                      : "border-gray-600 hover:border-yellow-400"
                  }`}
                >
                  {isSelected && <span className="text-xs font-bold">✓</span>}
                </button>

                {/* Player info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-sm font-medium truncate">{player.name}</span>
                    {isCaptain && <span className="text-xs bg-yellow-400 text-gray-900 px-1.5 py-0.5 rounded font-bold">C</span>}
                    {isVc && <span className="text-xs bg-gray-400 text-gray-900 px-1.5 py-0.5 rounded font-bold">VC</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[player.role]}`}>
                      {player.role}
                    </span>
                    <span className="text-gray-600 text-xs">{player.team}</span>
                  </div>
                </div>

                {/* Captain/VC buttons — only show if selected */}
                {isSelected && (
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleCaptain(player.cricketdata_player_id)}
                      className={`text-xs px-2 py-1 rounded-lg font-bold transition ${
                        isCaptain ? "bg-yellow-400 text-gray-900" : "bg-gray-800 text-gray-400 hover:text-yellow-400"
                      }`}
                    >
                      C
                    </button>
                    <button
                      onClick={() => handleVc(player.cricketdata_player_id)}
                      className={`text-xs px-2 py-1 rounded-lg font-bold transition ${
                        isVc ? "bg-gray-400 text-gray-900" : "bg-gray-800 text-gray-400 hover:text-gray-300"
                      }`}
                    >
                      VC
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Submit section */}
      <div className="sticky bottom-0 bg-gray-950 pt-3 pb-4">
        {error && <p className="text-red-400 text-sm mb-2 text-center">{error}</p>}
        {!isValid && validationErrors.length > 0 && (
          <p className="text-yellow-500 text-xs mb-2 text-center">{validationErrors[0]}</p>
        )}
        {saved ? (
          <div className="w-full bg-green-500 text-white font-bold py-3 rounded-2xl text-center">
            Team saved! Redirecting...
          </div>
        ) : (
          <button
            onClick={saveTeam}
            disabled={!isValid || saving}
            className="w-full bg-yellow-400 text-gray-900 font-bold py-3 rounded-2xl text-sm hover:bg-yellow-300 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : existingTeam ? "Update Team" : "Submit Team"}
          </button>
        )}
      </div>
    </div>
  )
}
