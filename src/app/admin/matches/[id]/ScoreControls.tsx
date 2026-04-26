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
  // True after a finalize/refinalize attempt failed with `canForce: true`,
  // i.e. the per-innings sanity guard rejected the data.  Surfaces the
  // "Force …" button so the admin can override after eyeballing the data.
  const [canForce, setCanForce] = useState(false)

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

  async function finalizeMatch(force = false) {
    if (force && !confirm(
      "Force Finalize bypasses the per-innings sanity check.\n\n" +
      "Only use this when you've VERIFIED the scorecard is complete (e.g. a team posted 145/3 — only 4 batters actually came to crease, so the data IS final, but it looks thin).\n\n" +
      "Total ≥15 entries is still required, so a truly empty scorecard can't slip through.\n\nProceed?"
    )) return
    setLoading(force ? "force-finalize" : "finalize")
    setMessage(null)
    setCanForce(false)
    const url = force ? `/api/admin/matches/${match.id}/finalize?force=1` : `/api/admin/matches/${match.id}/finalize`
    const data = await callApi(url)
    if (data.success) {
      const winners = data.results
        ?.filter((r: { prize_won: number }) => r.prize_won > 0)
        .map((r: { prize_won: number }) => `₹${r.prize_won}`).join(", ")
      setMessage(`Match finalized! Prizes: ${winners || "No payouts"}`)
    } else {
      setMessage(`Error: ${data.error}`)
      if (data.canForce) setCanForce(true)
    }
    setLoading(null)
    router.refresh()
  }

  async function refinalizeMatch(force = false) {
    if (!force && !confirm(
      "Re-finalize this completed match?\n\n" +
      "This will:\n" +
      "• Re-fetch the final scorecard\n" +
      "• Recompute every player's fantasy points\n" +
      "• Re-rank all teams\n" +
      "• Rewrite prize amounts in the ledger\n\n" +
      "Settled payouts will stay marked settled. " +
      "Use this ONLY if the original finalize ran on incomplete data."
    )) return
    if (force && !confirm(
      "Force Re-finalize bypasses the per-innings sanity check.\n\n" +
      "Only use when you've verified the scorecard is genuinely complete.\n\nProceed?"
    )) return
    setLoading(force ? "force-refinalize" : "refinalize")
    setMessage(null)
    setCanForce(false)
    const url = force ? `/api/admin/matches/${match.id}/refinalize?force=1` : `/api/admin/matches/${match.id}/refinalize`
    const data = await callApi(url)
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
      if (data.canForce) setCanForce(true)
    }
    setLoading(null)
    router.refresh()
  }

  async function recoverAbandoned() {
    if (!confirm(
      "Recover this abandoned match?\n\n" +
      "This will:\n" +
      "• Reverse the rollover added to the next match (so the prize doesn't double-count)\n" +
      "• Flip status from 'abandoned' back to 'live' so you can finalize\n\n" +
      "Use this when a match was wrongly abandoned (e.g. finalize was blocked by a sanity guard).\n\nProceed?"
    )) return
    setLoading("recover")
    setMessage(null)
    const data = await callApi(`/api/admin/matches/${match.id}/recover-abandoned`)
    if (data.success) {
      const rev = data.reversedFrom
        ? `Reversed ₹${data.rolloverReversed} from "${data.reversedFrom.name}" (rollover ${data.reversedFrom.before} → ${data.reversedFrom.after}). `
        : ""
      setMessage(`Recovered. ${rev}Status is now LIVE. Click "Finalize & Pay Out" next.`)
    } else {
      setMessage(`Error: ${data.error}`)
    }
    setLoading(null)
    router.refresh()
  }

  if (match.status === "upcoming") return null

  const isCompleted = match.status === "completed"
  const isAbandoned = match.status === "abandoned"

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
            onClick={() => finalizeMatch(false)}
            disabled={!!loading}
            className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
          >
            {loading === "finalize" ? "Finalizing..." : "Finalize & Pay Out"}
          </button>
        )}
        {match.status === "live" && canForce && (
          <button
            onClick={() => finalizeMatch(true)}
            disabled={!!loading}
            className="bg-orange-600 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-orange-500 transition disabled:opacity-50"
            title="Bypass the per-innings sanity guard. Use only when the data is verified complete."
          >
            {loading === "force-finalize" ? "Forcing…" : "Force Finalize (data IS complete)"}
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
        {isAbandoned && (
          <button
            onClick={recoverAbandoned}
            disabled={!!loading}
            className="bg-emerald-600 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-emerald-500 transition disabled:opacity-50"
            title="Reverse the rollover and flip status back to live, so you can finalize this match."
          >
            {loading === "recover" ? "Recovering…" : "Recover Match (un-abandon)"}
          </button>
        )}
        {isCompleted && (
          <button
            onClick={() => refinalizeMatch(false)}
            disabled={!!loading}
            className="bg-purple-700 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-purple-600 transition disabled:opacity-50"
            title="Re-fetch the scorecard and recompute all player points + prizes. Use if the original finalize ran on incomplete data."
          >
            {loading === "refinalize" ? "Re-finalizing…" : "Re-finalize (fix scores)"}
          </button>
        )}
        {isCompleted && canForce && (
          <button
            onClick={() => refinalizeMatch(true)}
            disabled={!!loading}
            className="bg-orange-600 text-white font-semibold px-4 py-2 rounded-xl text-sm hover:bg-orange-500 transition disabled:opacity-50"
            title="Bypass the per-innings sanity guard."
          >
            {loading === "force-refinalize" ? "Forcing…" : "Force Re-finalize"}
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
