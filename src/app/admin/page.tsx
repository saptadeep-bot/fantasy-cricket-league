import { auth } from "@/auth"
import { redirect } from "next/navigation"
import Navbar from "@/components/Navbar"
import RecalculatePrizesButton from "./RecalculatePrizesButton"
import SeedHistoricalStatsButton from "./SeedHistoricalStatsButton"

export default async function AdminPage() {
  const session = await auth()
  if (!session) redirect("/login")
  if (!session.user.is_admin) redirect("/")

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        <h1 className="text-xl font-bold text-white mb-6">Admin Panel</h1>
        <div className="grid gap-4">
          <a href="/admin/matches" className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-yellow-400 transition">
            <h2 className="font-semibold text-white">🗓 Match Management</h2>
            <p className="text-gray-500 text-sm mt-1">Import matches, lock teams, manage status</p>
          </a>
          <a href="/admin/users" className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-yellow-400 transition">
            <h2 className="font-semibold text-white">👥 Player Management</h2>
            <p className="text-gray-500 text-sm mt-1">Add friends, view accounts</p>
          </a>
          <a href="/admin/scores" className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-yellow-400 transition">
            <h2 className="font-semibold text-white">📊 Score Sync</h2>
            <p className="text-gray-500 text-sm mt-1">Fetch & finalize match scores</p>
          </a>
          <a href="/admin/ledger" className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-yellow-400 transition">
            <h2 className="font-semibold text-white">💰 Payout Ledger</h2>
            <p className="text-gray-500 text-sm mt-1">Track settlements and balances</p>
          </a>

          {/* Pre-app historical stats */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="font-semibold text-white mb-1">📜 Add Pre-App Stats to Leaderboard</h2>
            <p className="text-gray-500 text-sm mb-4">
              Adds the 6 matches played before the app to each player&apos;s leaderboard totals. No match records created — just stats.
            </p>
            <SeedHistoricalStatsButton />
          </div>

          {/* One-time retroactive prize recalculation */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="font-semibold text-white mb-1">🔄 Recalculate All Prizes</h2>
            <p className="text-gray-500 text-sm mb-4">
              Recalculates prize payouts for all completed matches using the new system: ₹250 per person · 65% to 1st · 35% to 2nd.
              Run this once to fix all past matches.
            </p>
            <RecalculatePrizesButton />
          </div>
        </div>
      </main>
    </div>
  )
}
