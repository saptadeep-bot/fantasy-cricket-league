"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"

interface Match {
  id: string
  status: string
  cricketdata_match_id?: string
  result_announcement?: string
}

export default function ScoreControls({ match }: { match: Match }) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState(match.result_announcement || "")
  const [newMatchId, setNewMatchId] = useState("")

  async function callApi(endpoint: string, body?: object) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.json()
  }

  async function setStatus(status: string) {
    setLoading(status)
    setMessage(null)
    const data = await callApi(`/api/admin/matches/${match.id}/status`, { status, announcement: announcement || undefined })
    setMessage(data.success ? `Status set to ${status}` : `Error: ${data.error}`)
    setLoading(null)
    router.refresh()
  }

  async function fetchScores() {
    setLoading("scores")
    setMessage(null)
    const data = await callApi(`/api/admin/matches/${match.id}/scores`)
    if (data.success) {
      setMessage(data.message || `Updated ${data.updated}/${data.total} player scores`)
    } else if (data.liveInProgress) {
      setMessage(`ℹ️ ${data.error}`)
    } else if (data.notStarted) {
      setMessage(`ℹ️ ${data.error}`)
    } else {
      setMessage(`Error: ${data.error}`)
    }
    setLoading(null)
    router.refresh()
  }

  async function fixMatchId() {
    const id = newMatchId.trim()
    if (!id) return
    setLoading("fixid")
    setMessage(null)
    const data = await callApi(`/api/admin/debug-live`, { matchId: match.id, newCricketdataId: id })
    if (data.success) {
      setMessage(`Match ID updated. Now press "Fetch Scores Now".`)
      setNewMatchId("")
    } else {
      setMessage(`Error: ${data.error}`)
    }
    setLoading(null)
    router.refresh()
  }

  async function finalizeMatch() {
    setLoading("finalize")
    setMessage(null)
    const data = await callApi(`/api/admin/matches/${match.id}/finalize`)
    if (data.success) {
      const winners = data.results
        ?.filter((r: { prize_won: number }) => r.prize_won > 0)
        .map((r: { prize_won: number }) => `₹${r.prize_won}`).join(", ")
      setMessage(`Match finalized! Prizes: ${winners || "No payouts"}`)
    } else {
      setMessage(`Error: ${data.error}`)
    }
    setLoading(null)
    router.refresh()
  }

  async function refinalizeMatch() {
    if (!confirm(
      "Re-finalize this completed match?\n\n" +
      "This will:\n" +
      "• Re-fetch the final scorecard\n" +
      "• Recompute every player's fantasy points\n" +
      "• Re-rank all teams\n" +
      "• Rewrite prize amounts in the ledger\n\n" +
      "Settled payouts will stay marked settled. " +
      "Use this ONLY if the original finalize ran on incomplete data."
    )) return
    setLoading("refinalize")
    setMessage(null)
    const data = await callApi(`/api/admin/matches/${match.id}/refinalize`)
    if (data.success) {
      const winners = data.results
        ?.filter((r: { prize_won: number }) => r.prize_won > 0)
        .map((r: { prize_won: number; rank: number }) => `#${r.rank}: ₹${r.prize_won}`).join(", ")
      setMessage(
        `Re-finalized from ${data.source}. ${data.computeResult?.updated ?? 0}/${data.computeResult?.total ?? 0} player scores updated. ` +
        `Prizes: ${winners || "No payouts"}`
      )
    } else {
      setMessage(`Error: ${data.error}`)
    }
    setLoading(null)
    router.refresh()
  }

  if (match.status === "upcoming") return null

  const isCompleted = match.status === "completed"

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-white">Match Controls</h3>

      {/* Status buttons */}
      <div className="flex flex-wrap gap-2">
        {match.status === "locked" && (
          <button
            onClick={() => setStatus("live")}
            disabled={!!loading}
            className="bg-green-600 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-green-500 transition disabled:opacity-50"
          >
            {loading === "live" ? "..." : "Mark as Live"}
          </button>
        )}
        {(match.status === "live" || match.status === "locked") && (
          <button
            onClick={fetchScores}
            disabled={!!loading}
            className="bg-blue-600 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-blue-500 transition disabled:opacity-50"
          >
            {loading === "scores" ? "Fetching..." : "Fetch Scores Now"}
          </button>
        )}
        {match.status === "live" && (
          <button
            onClick={finalizeMatch}
            disabled={!!loading}
            className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
          >
            {loading === "finalize" ? "Finalizing..." : "Finalize & Pay Out"}
          </button>
        )}
        {!["completed", "abandoned"].includes(match.status) && (
          <button
            onClick={() => setStatus("abandoned")}
            disabled={!!loading}
            className="bg-red-900 text-red-300 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-red-800 transition disabled:opacity-50"
          >
            Mark Abandoned
          </button>
        )}
        {isCompleted && (
          <button
            onClick={refinalizeMatch}
            disabled={!!loading}
            className="bg-purple-700 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-purple-600 transition disabled:opacity-50"
            title="Re-fetch the scorecard and recompute all player points + prizes. Use if the original finalize ran on incomplete data."
          >
            {loading === "refinalize" ? "Re-finalizing…" : "Re-finalize (fix scores)"}
          </button>
        )}
      </div>

      {/* Fix API Match ID — use if scores say "not available" */}
      {(match.status === "live" || match.status === "locked") && (
        <div>
          <label className="text-gray-400 text-xs block mb-1">
            API Match ID override{match.cricketdata_match_id ? <span className="text-gray-600 ml-2">current: {match.cricketdata_match_id}</span> : null}
          </label>
          <div className="flex gap-2">
            <input
              value={newMatchId}
              onChange={e => setNewMatchId(e.target.value)}
              placeholder="Paste correct ID from cricapi if scores not loading"
              className="flex-1 bg-gray-800 text-white rounded-xl px-3 py-2 text-sm border border-gray-700 focus:outline-none focus:border-yellow-400 font-mono"
            />
            <button
              onClick={fixMatchId}
              disabled={!!loading || !newMatchId.trim()}
              className="bg-orange-600 text-white px-3 py-2 rounded-xl text-sm hover:bg-orange-500 transition disabled:opacity-50 whitespace-nowrap"
            >
              {loading === "fixid" ? "Saving…" : "Fix ID"}
            </button>
          </div>
        </div>
      )}

      {/* Result announcement */}
      {match.status === "live" && (
        <div>
          <label className="text-gray-400 text-sm block mb-1">Result announcement (optional)</label>
          <div className="flex gap-2">
            <input
              value={announcement}
              onChange={e => setAnnouncement(e.target.value)}
              placeholder="e.g. DC won by 6 wkts. Sameer Rizvi 93pts!"
              className="flex-1 bg-gray-800 text-white rounded-xl px-3 py-2 text-sm border border-gray-700 focus:outline-none focus:border-yellow-400"
            />
            <button
              onClick={() => callApi(`/api/admin/matches/${match.id}/status`, { status: match.status, announcement })}
              className="bg-gray-700 text-white px-3 py-2 rounded-xl text-sm hover:bg-gray-600"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className={`text-sm ${
          message.startsWith("Error") ? "text-red-400" :
          message.startsWith("ℹ️") ? "text-blue-400" :
          "text-green-400"
        }`}>
          {message}
        </p>
      )}
    </div>
  )
}
