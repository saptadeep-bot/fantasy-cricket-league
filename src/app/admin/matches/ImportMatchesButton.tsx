"use client"
import { useState } from "react"

export default function ImportMatchesButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function handleImport() {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch("/api/admin/import-matches", { method: "POST" })
      const data = await res.json()
      if (data.success) {
        setResult(`✅ Imported ${data.imported} matches (${data.skipped} skipped)`)
      } else {
        setResult(`❌ Error: ${data.error}`)
      }
    } catch {
      setResult("❌ Network error")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={handleImport}
        disabled={loading}
        className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition disabled:opacity-50"
      >
        {loading ? "Importing..." : "Import All 70 Matches"}
      </button>
      {result && <p className="mt-2 text-sm text-gray-300">{result}</p>}
    </div>
  )
}
