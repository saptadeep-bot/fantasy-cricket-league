"use client"
import { useState } from "react"

interface MatchSummary {
  match: string
  participants?: number
  totalPool?: number
  prizes?: string
  status: string
}

export default function RecalculatePrizesButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<MatchSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function recalculate() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch("/api/admin/recalculate-prizes", { method: "POST" })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        setResult(data.summary)
      }
    } catch {
      setError("Network error. Try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={recalculate}
        disabled={loading}
        className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
      >
        {loading ? "Recalculating..." : "Recalculate Past Match Prizes"}
      </button>

      {error && (
        <p className="mt-3 text-red-400 text-sm">{error}</p>
      )}

      {result && (
        <div className="mt-4 space-y-2">
          {result.map((r, i) => (
            <div key={i} className={`rounded-xl p-3 text-sm ${r.status === "updated" ? "bg-green-900/20 border border-green-800/50" : "bg-gray-800 border border-gray-700"}`}>
              <p className={`font-medium ${r.status === "updated" ? "text-green-400" : "text-gray-400"}`}>{r.match}</p>
              {r.status === "updated" && (
                <p className="text-gray-400 text-xs mt-0.5">
                  {r.participants} players · Pool ₹{r.totalPool} · Prizes: {r.prizes}
                </p>
              )}
              {r.status !== "updated" && (
                <p className="text-gray-500 text-xs mt-0.5">{r.status}</p>
              )}
            </div>
          ))}
          <p className="text-green-400 text-sm font-medium pt-1">✓ Done! All prize amounts updated.</p>
        </div>
      )}
    </div>
  )
}
