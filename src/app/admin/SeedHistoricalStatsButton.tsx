"use client"
import { useState } from "react"

export default function SeedHistoricalStatsButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ name: string; status: string; matches?: number; invested?: string; won?: string; pnl?: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function seed() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch("/api/admin/seed-historical-stats", { method: "POST" })
      const data = await res.json()
      if (data.error) setError(data.error)
      else setResult(data.summary)
    } catch {
      setError("Network error. Try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={seed}
        disabled={loading}
        className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
      >
        {loading ? "Saving..." : "Save Pre-App Stats to Leaderboard"}
      </button>

      {error && <p className="mt-3 text-red-400 text-sm">{error}</p>}

      {result && (
        <div className="mt-4 space-y-2">
          {result.map((r, i) => (
            <div key={i} className={`rounded-xl p-3 text-sm ${r.status.includes("✓") ? "bg-green-900/20 border border-green-800/50" : "bg-gray-800 border border-gray-700"}`}>
              <p className={`font-medium ${r.status.includes("✓") ? "text-green-400" : "text-gray-400"}`}>{r.name}</p>
              {r.status.includes("✓") && (
                <p className="text-gray-400 text-xs mt-0.5">
                  {r.matches} matches · {r.invested} invested · {r.won} won · Net {r.pnl}
                </p>
              )}
              {!r.status.includes("✓") && <p className="text-gray-500 text-xs">{r.status}</p>}
            </div>
          ))}
          <p className="text-green-400 text-sm font-medium pt-1">✓ Leaderboard updated with pre-app history.</p>
        </div>
      )}
    </div>
  )
}
