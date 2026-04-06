"use client"
import { useState } from "react"

interface MatchSummary {
  match: string
  status: string
  participants?: number
  pool?: string
  first?: string
  second?: string
}

export default function SeedHistoricalButton() {
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<MatchSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function seed() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch("/api/admin/seed-historical", { method: "POST" })
      const data = await res.json()
      if (data.error) setError(data.error)
      else setResult(data.summary)
    } catch {
      setError("Network error. Try again.")
    } finally {
      setLoading(false)
    }
  }

  async function deleteSeed() {
    if (!confirm("Delete all 6 pre-app historical match records? This cannot be undone.")) return
    setDeleting(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch("/api/admin/seed-historical", { method: "DELETE" })
      const data = await res.json()
      if (data.error) setError(data.error)
      else setResult([{ match: "Done", status: `Deleted ${data.deleted} historical match(es)` }])
    } catch {
      setError("Network error. Try again.")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <button
          onClick={seed}
          disabled={loading || deleting}
          className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
        >
          {loading ? "Seeding..." : "Add Pre-App Match History"}
        </button>
        <button
          onClick={deleteSeed}
          disabled={loading || deleting}
          className="bg-red-900/40 text-red-400 border border-red-800/50 font-semibold px-3 py-2 rounded-xl text-sm hover:bg-red-900/60 transition disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Reset"}
        </button>
      </div>

      {error && <p className="mt-3 text-red-400 text-sm">{error}</p>}

      {result && (
        <div className="mt-4 space-y-2">
          {result.map((r, i) => (
            <div key={i} className={`rounded-xl p-3 text-sm ${r.status.includes("✓") ? "bg-green-900/20 border border-green-800/50" : "bg-gray-800 border border-gray-700"}`}>
              <p className={`font-medium ${r.status.includes("✓") ? "text-green-400" : "text-gray-400"}`}>{r.match}</p>
              {r.status.includes("✓") ? (
                <p className="text-gray-400 text-xs mt-0.5">
                  {r.participants} players · {r.pool} pool · 1st: {r.first} · 2nd: {r.second}
                </p>
              ) : (
                <p className="text-gray-500 text-xs mt-0.5">{r.status}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
