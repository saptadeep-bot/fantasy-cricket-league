import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import Navbar from "@/components/Navbar"

export const revalidate = 0

export default async function LedgerPage() {
  const session = await auth()
  if (!session) redirect("/login")

  // Fetch all users
  const { data: users } = await supabaseAdmin.from("users").select("id, name")

  // Fetch all results with match info
  const { data: results } = await supabaseAdmin
    .from("match_results")
    .select("*, matches(name, match_number, scheduled_at, match_type), users(name)")
    .order("created_at", { ascending: false })

  function getEntryFee(matchType: string): number {
    const type = (matchType || "league").toLowerCase()
    if (type === "final") return 500
    if (type === "eliminator" || type === "qualifier" || type.includes("qualifier") || type.includes("eliminator")) return 350
    return 250
  }

  // Compute net balance per user based on per-match entry fees
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const balances = (users || []).map(user => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userResults = (results || []).filter((r: any) => r.user_id === user.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalWon = userResults.reduce((s: number, r: any) => s + (r.prize_won || 0), 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalInvested = userResults.reduce((s: number, r: any) => s + getEntryFee(r.matches?.match_type || "league"), 0)
    return {
      id: user.id,
      name: user.name,
      totalWon: Math.round(totalWon),
      totalInvested,
      netBalance: Math.round(totalWon - totalInvested),
    }
  }).sort((a, b) => b.netBalance - a.netBalance)

  const currentUserId = session.user.id

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <h1 className="text-xl font-bold text-white">Payout Ledger</h1>
        <p className="text-gray-500 text-sm -mt-3">Money transfers happen via UPI outside the app. This tracks what&apos;s owed.</p>

        {/* Net balances */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-4">Net Balances</h2>
          <div className="space-y-3">
            {balances.map(player => (
              <div key={player.id} className={`flex items-center justify-between ${player.id === currentUserId ? "opacity-100" : "opacity-80"}`}>
                <div className="flex items-center gap-2">
                  <span className="text-white text-sm font-medium">{player.name}</span>
                  {player.id === currentUserId && <span className="text-xs text-yellow-400">You</span>}
                </div>
                <div className="text-right">
                  <p className={`font-bold ${player.netBalance > 0 ? "text-green-400" : player.netBalance < 0 ? "text-red-400" : "text-gray-400"}`}>
                    {player.netBalance > 0 ? "+" : ""}₹{player.netBalance}
                  </p>
                  <p className="text-gray-600 text-xs">₹{player.totalWon} won · ₹{player.totalInvested} invested</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Transaction log */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-4">Transaction Log</h2>
          {!results || results.filter(r => r.prize_won > 0).length === 0 ? (
            <p className="text-gray-500 text-sm">No payouts yet.</p>
          ) : (
            <div className="space-y-2">
              {results
                .filter(r => r.prize_won > 0)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((r: any) => (
                  <div key={r.id} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                    <div>
                      <p className="text-white text-sm font-medium">{r.users?.name}</p>
                      <p className="text-gray-500 text-xs">
                        {r.matches?.name} · #{r.rank}
                        {" · "}{new Date(r.matches?.scheduled_at).toLocaleDateString("en-IN", { dateStyle: "short", timeZone: "Asia/Kolkata" })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-yellow-400 font-semibold">+₹{r.prize_won}</span>
                      {r.is_settled
                        ? <span className="text-xs text-green-500 bg-green-900/30 px-2 py-0.5 rounded-full">Settled</span>
                        : <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">Pending</span>
                      }
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
