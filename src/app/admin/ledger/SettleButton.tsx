"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"

export default function SettleButton({ resultId }: { resultId: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function settle() {
    setLoading(true)
    await fetch(`/api/admin/results/${resultId}/settle`, { method: "POST" })
    setLoading(false)
    router.refresh()
  }

  return (
    <button
      onClick={settle}
      disabled={loading}
      className="text-xs bg-green-900 text-green-400 hover:bg-green-800 px-3 py-1 rounded-lg transition disabled:opacity-50"
    >
      {loading ? "..." : "Mark Settled"}
    </button>
  )
}
