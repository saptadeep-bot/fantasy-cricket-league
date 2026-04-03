import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import Navbar from "@/components/Navbar"
import Link from "next/link"

export const revalidate = 0

export default async function LeaderboardPage() {
  const session = await auth()
  if (!session) redirect("/login")

  // Fetch all users
  const { data: users } = await supabaseAdmin
    .from("users")
    .select("id, name")

  // Fetch all match results
  const { data: results } = await supabaseAdmin
    .from("match_results")
    .select("user_id, rank, final_points, prize_won")

  // Fetch total season reserve
  const { data: reserve } = await supabaseAdmin
    .from("season_reserve")
    .select("amount")

  const totalReserve = reserve?.reduce((sum, r) => sum + (r.amount || 0), 0) || 0

  // Compute per-user stats
  const stats = (users || []).map(user => {
    const userResults = (results || []).filter(r => r.user_id === user.id)
    return {
      id: user.id,
      name: user.name,
      matchesPlayed: userResults.length,
      totalPoints: Math.round(userResults.reduce((s, r) => s + (r.final_points || 0), 0) * 10) / 10,
      firstPlaceWins: userResults.filter(r => r.rank === 1).length,
      secondPlaceWins: userResults.filter(r => r.rank === 2).length,
      totalPrizeWon: Math.round(userResults.reduce((s, r) => s + (r.prize_won || 0), 0) * 100) / 100,
    }
  }).sort((a, b) => b.totalPoints - a.totalPoints)

  const currentUserId = session.user.id

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <h1 className="text-xl font-bold text-white">Season Leaderboard</h1>

        {/* Season reserve banner */}
        <div className="bg-gradient-to-r from-yellow-900/40 to-yellow-800/20 border border-yellow-700/40 rounded-2xl p-4 flex items-center justify-between">
          <div>
            <p className="text-yellow-400 font-semibold">Season Reserve Pot 🏆</p>
            <p className="text-gray-400 text-xs mt-0.5">Awarded to top 2 at end of IPL 2026</p>
          </div>
          <p className="text-yellow-400 font-bold text-2xl">₹{totalReserve}</p>
        </div>

        {/* Leaderboard table */}
        {stats.length === 0 || stats.every(s => s.matchesPlayed === 0) ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-gray-500">No matches completed yet. Check back after the first match!</p>
          </div>
        ) : (
          <div className="space-y-3">
            {stats.map((player, idx) => {
              const isMe = player.id === currentUserId
              const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : null
              return (
                <div key={player.id} className={`bg-gray-900 border rounded-2xl p-4 ${isMe ? "border-yellow-400/50" : "border-gray-800"}`}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 text-center">
                      {medal ? <span className="text-xl">{medal}</span> : <span className="text-gray-600 font-bold">#{idx + 1}</span>}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-semibold">{player.name}</p>
                        {isMe && <span className="text-xs text-yellow-400">You</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-gray-500 text-xs">{player.matchesPlayed} matches</span>
                        {player.firstPlaceWins > 0 && <span className="text-xs text-yellow-400">🥇 ×{player.firstPlaceWins}</span>}
                        {player.secondPlaceWins > 0 && <span className="text-xs text-gray-400">🥈 ×{player.secondPlaceWins}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-white font-bold">{player.totalPoints} pts</p>
                      {player.totalPrizeWon > 0 && (
                        <p className="text-yellow-400 text-sm">₹{player.totalPrizeWon} won</p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Stats grid */}
        {stats.some(s => s.matchesPlayed > 0) && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-white font-semibold mb-3">Season Stats</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs uppercase">
                    <th className="text-left pb-2">Player</th>
                    <th className="text-right pb-2">Played</th>
                    <th className="text-right pb-2">Pts</th>
                    <th className="text-right pb-2">1st</th>
                    <th className="text-right pb-2">2nd</th>
                    <th className="text-right pb-2">Won</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {stats.map(player => (
                    <tr key={player.id} className={player.id === currentUserId ? "text-yellow-400" : "text-gray-300"}>
                      <td className="py-2 font-medium">{player.name}</td>
                      <td className="py-2 text-right text-gray-500">{player.matchesPlayed}</td>
                      <td className="py-2 text-right font-semibold">{player.totalPoints}</td>
                      <td className="py-2 text-right">{player.firstPlaceWins}</td>
                      <td className="py-2 text-right">{player.secondPlaceWins}</td>
                      <td className="py-2 text-right">₹{player.totalPrizeWon}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
