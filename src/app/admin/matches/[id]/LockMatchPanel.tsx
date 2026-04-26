"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"

interface Player {
  id: string
  cricketdata_player_id: string
  name: string
  team: string
  role: string
  is_playing?: boolean
  is_substitute?: boolean
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
  // Pre-select announced players if squad was previously confirmed
  const [selectedXI, setSelectedXI] = useState<Set<string>>(
    new Set(existingPlayers.filter(p => p.is_playing && !p.is_substitute).map(p => p.cricketdata_player_id))
  )
  const [substituteIds, setSubstituteIds] = useState<Set<string>>(
    new Set(existingPlayers.filter(p => p.is_substitute).map(p => p.cricketdata_player_id))
  )
  const [loading, setLoading] = useState(false)
  const [locking, setLocking] = useState(false)
  const [closing, setClosing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [squadSaved, setSquadSaved] = useState(existingPlayers.length > 0)

  // Manual "Add missing player" form state — safety valve for players that
  // neither cricapi nor EntitySport return (happens for late-named impact
  // subs like G Linde on 2026-04-22).
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [addName, setAddName] = useState("")
  const [addTeam, setAddTeam] = useState("")
  const [addRole, setAddRole] = useState<"BAT" | "BOWL" | "ALL" | "WK">("BAT")
  const [addingPlayer, setAddingPlayer] = useState(false)

  const alreadyLocked = match.status !== "upcoming"

  async function fetchSquad() {
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/fetch-squad`, { method: "POST" })
      const data = await res.json()
      if (data.success) {
        setSquadPlayers(data.players)
        // Preserve any existing is_playing selections
        setSelectedXI(new Set(existingPlayers.filter(p => p.is_playing).map(p => p.cricketdata_player_id)))
        setSquadSaved(true)
        const c = data.counts ?? {}
        const breakdown = [
          typeof c.total === "number" ? `${c.total} total` : null,
          c.inserted ? `+${c.inserted} new` : null,
          c.entitysportOnly ? `${c.entitysportOnly} from EntitySport` : null,
          c.preserved ? `${c.preserved} preserved` : null,
          c.rogueCleaned ? `${c.rogueCleaned} wrong-team rows removed` : null,
        ].filter(Boolean).join(", ")
        // `warning` is non-fatal — squad partially fetched, e.g. cricapi
        // returned the wrong team for one side.  Show it in place of the
        // success message so the admin can't miss it.
        if (data.warning) {
          setMessage(`⚠️ ${data.warning} (${breakdown})`)
        } else {
          setMessage(`Squad updated (${breakdown}). Friends can pick their teams!`)
        }
      } else {
        setMessage(`Error: ${data.error}`)
      }
    } catch {
      setMessage("Network error")
    } finally {
      setLoading(false)
    }
  }

  async function addMissingPlayer() {
    const name = addName.trim()
    const team = addTeam || match.team1
    if (!name) { setMessage("Enter a player name"); return }
    setAddingPlayer(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/add-player`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, team, role: addRole }),
      })
      const data = await res.json()
      if (data.success && data.player) {
        // Append the new player to local state (avoids a round-trip).  Mark
        // them pre-selected as XI so the admin sees them in the chosen group.
        setSquadPlayers(prev => [...prev, data.player as Player])
        setSelectedXI(prev => new Set([...prev, data.player.cricketdata_player_id]))
        setAddName("")
        setMessage(`Added ${data.player.name} to ${data.player.team}.`)
      } else {
        setMessage(`Error: ${data.error}`)
      }
    } catch {
      setMessage("Network error")
    } finally {
      setAddingPlayer(false)
    }
  }

  // Cycle: unselected → XI → Sub → unselected
  function togglePlayer(playerId: string) {
    if (alreadyLocked) return
    const isXI = selectedXI.has(playerId)
    const isSub = substituteIds.has(playerId)

    if (!isXI && !isSub) {
      // unselected → XI
      setSelectedXI(prev => new Set([...prev, playerId]))
    } else if (isXI && !isSub) {
      // XI → Sub
      setSelectedXI(prev => { const n = new Set(prev); n.delete(playerId); return n })
      setSubstituteIds(prev => new Set([...prev, playerId]))
    } else {
      // Sub → unselected
      setSubstituteIds(prev => { const n = new Set(prev); n.delete(playerId); return n })
    }
  }

  // Validation — count XI + subs per team (all announced)
  const uniqueTeams = [...new Set(squadPlayers.map(p => p.team))].filter(Boolean)
  const allAnnouncedIds = new Set([...selectedXI, ...substituteIds])
  const announcedPlayers = squadPlayers.filter(p => allAnnouncedIds.has(p.cricketdata_player_id))
  const team1Players = announcedPlayers.filter(p => p.team === (uniqueTeams[0] || match.team1))
  const team2Players = announcedPlayers.filter(p => p.team === (uniqueTeams[1] || match.team2))
  const xiOnly = squadPlayers.filter(p => selectedXI.has(p.cricketdata_player_id))
  const team1XI = xiOnly.filter(p => p.team === (uniqueTeams[0] || match.team1))
  const team2XI = xiOnly.filter(p => p.team === (uniqueTeams[1] || match.team2))
  const isValidXI =
    team1XI.length === 11 && team2XI.length === 11

  async function confirmAnnounced() {
    if (!isValidXI) return
    setLocking(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedPlayerIds: Array.from(selectedXI),
          substitutePlayerIds: Array.from(substituteIds),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setMessage(`Announced players marked (${selectedXI.size}). Friends can edit their teams.`)
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

  async function lockMatch() {
    setClosing(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/matches/${match.id}/close`, { method: "POST" })
      const data = await res.json()
      if (data.success) {
        setMessage("Match locked. Team selection is now closed.")
        router.refresh()
      } else {
        setMessage(`Error: ${data.error}`)
      }
    } catch {
      setMessage("Network error")
    } finally {
      setClosing(false)
    }
  }

  const team1Squad = squadPlayers.filter(p => p.team === (uniqueTeams[0] || match.team1))
  const team2Squad = squadPlayers.filter(p => p.team === (uniqueTeams[1] || match.team2))

  return (
    <div className="space-y-4">
      {/* Fetch squad */}
      {!alreadyLocked && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h3 className="font-semibold text-white mb-1">Step 1 — Fetch Full Squad</h3>
          <p className="text-gray-500 text-sm mb-4">
            Fetch anytime — even days before the match. Friends can start picking teams immediately.
            Re-fetches merge cricapi + EntitySport and never remove existing players.
          </p>
          <button
            onClick={fetchSquad}
            disabled={loading}
            className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
          >
            {loading ? "Fetching..." : squadSaved ? "Re-fetch Squad" : "Fetch Squad from API"}
          </button>
          {message && (
            <p className={`mt-2 text-sm ${
              message.startsWith("Error") || message.startsWith("Network") ? "text-red-400" :
              message.startsWith("⚠️") ? "text-yellow-400" :
              "text-gray-300"
            }`}>
              {message}
            </p>
          )}

          {/* Safety valve: manual add for players that neither feed returned */}
          {squadSaved && (
            <div className="mt-4 pt-4 border-t border-gray-800">
              {!showAddPlayer ? (
                <button
                  type="button"
                  onClick={() => { setShowAddPlayer(true); setAddTeam(match.team1) }}
                  className="text-sm text-gray-400 hover:text-yellow-400 transition"
                >
                  + Add missing player manually
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-gray-400 text-xs">
                    Use this only when a player is announced but not showing above
                    (e.g. a late-named impact sub neither API returned).
                  </p>
                  <input
                    type="text"
                    placeholder="Player name"
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-yellow-400"
                  />
                  <div className="flex gap-2">
                    <select
                      value={addTeam}
                      onChange={e => setAddTeam(e.target.value)}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-400"
                    >
                      <option value={match.team1}>{match.team1}</option>
                      <option value={match.team2}>{match.team2}</option>
                    </select>
                    <select
                      value={addRole}
                      onChange={e => setAddRole(e.target.value as typeof addRole)}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-400"
                    >
                      <option value="BAT">BAT</option>
                      <option value="BOWL">BOWL</option>
                      <option value="ALL">ALL</option>
                      <option value="WK">WK</option>
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={addMissingPlayer}
                      disabled={addingPlayer || !addName.trim()}
                      className="bg-green-600 text-white font-semibold px-3 py-2 rounded-lg text-sm hover:bg-green-500 transition disabled:opacity-50"
                    >
                      {addingPlayer ? "Adding..." : "Add Player"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowAddPlayer(false); setAddName("") }}
                      className="bg-gray-800 text-gray-400 px-3 py-2 rounded-lg text-sm hover:text-white transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
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
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`font-semibold ${players.filter(p => selectedXI.has(p.cricketdata_player_id)).length === 11 ? "text-green-400" : "text-yellow-400"}`}>
                      XI: {players.filter(p => selectedXI.has(p.cricketdata_player_id)).length}/11
                    </span>
                    <span className="text-orange-400 font-semibold">
                      Sub: {players.filter(p => substituteIds.has(p.cricketdata_player_id)).length}
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  {players.map(player => {
                    const isXI = selectedXI.has(player.cricketdata_player_id)
                    const isSub = substituteIds.has(player.cricketdata_player_id)
                    return (
                      <button
                        key={player.cricketdata_player_id}
                        onClick={() => togglePlayer(player.cricketdata_player_id)}
                        disabled={alreadyLocked}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm transition ${
                          isXI
                            ? "bg-green-900/30 border border-green-600/60 text-white"
                            : isSub
                            ? "bg-orange-900/30 border border-orange-600/60 text-white"
                            : "bg-gray-800 border border-transparent text-gray-400 hover:text-white hover:bg-gray-700"
                        } ${alreadyLocked ? "cursor-default" : "cursor-pointer"}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[player.role] || "bg-gray-700 text-gray-300"}`}>
                            {player.role}
                          </span>
                          <span>{player.name}</span>
                        </div>
                        {isXI && <span className="text-green-400 text-xs font-semibold">✓ XI</span>}
                        {isSub && <span className="text-orange-400 text-xs font-semibold">⚡ Sub</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Mark announced players (after toss) */}
          {!alreadyLocked && (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
              <h3 className="font-semibold text-white mb-1">Step 2 — Mark Announced Players (After Toss)</h3>
              <p className="text-gray-500 text-sm mb-1">
                <span className="text-green-400 font-semibold">1 tap = Playing XI</span> · <span className="text-orange-400 font-semibold">2 taps = Impact Sub</span> · 3 taps = remove
              </p>
              <p className="text-gray-500 text-sm mb-3">
                Mark exactly 11 XI per team. Subs are optional.
              </p>
              {!isValidXI && (selectedXI.size > 0 || substituteIds.size > 0) && (
                <p className="text-red-400 text-sm mb-3">
                  Need exactly 11 XI per team. ({team1XI.length} + {team2XI.length} so far)
                </p>
              )}
              <button
                onClick={confirmAnnounced}
                disabled={!isValidXI || locking}
                className="bg-blue-500 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-blue-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {locking ? "Saving..." : "Mark Announced Players"}
              </button>
            </div>
          )}

          {/* Lock Match */}
          {!alreadyLocked && squadSaved && (
            <div className="bg-gray-900 border border-orange-900 rounded-2xl p-5">
              <h3 className="font-semibold text-white mb-1">Step 3 — Lock Match</h3>
              <p className="text-gray-500 text-sm mb-3">
                Close team selection right before the match starts.
              </p>
              <button
                onClick={lockMatch}
                disabled={closing}
                className="bg-orange-500 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-orange-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {closing ? "Locking..." : "Lock Match (Close Team Selection)"}
              </button>
            </div>
          )}

          {alreadyLocked && (
            <div className="bg-green-900/20 border border-green-800 rounded-2xl p-4 text-center">
              <p className="text-green-400 font-medium">Match is {match.status} — Team selection closed</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
