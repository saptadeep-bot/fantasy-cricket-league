import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import Navbar from "@/components/Navbar"
import Link from "next/link"

export const revalidate = 0

export default async function HistoryPage() {
  const session = await auth()
  if (!session) redirect("/login")

  const { data: matches } = await supabaseAdmin
    .from("matches")
    .select("*, match_results(rank, prize_won, final_points, user_id, users(name))")
    .in("status", ["completed", "abandoned"])
    .order("scheduled_at", { ascending: false })

  const currentUserId = session.user.id

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <h1 className="text-xl font-bold text-white">Match History</h1>

        {!matches || matches.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-gray-500">No completed matches yet.</p>
          </div>
        ) : (
          matches.map(match => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const myResult = match.match_results?.find((r: any) => r.user_id === currentUserId)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const winner = match.match_results?.find((r: any) => r.rank === 1)
            const prizePool = (match.base_prize || 0) + (match.rollover_added || 0)

            return (
              <Link key={match.id} href={`/match/${match.id}`} className="block">
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 hover:border-gray-700 transition">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-white font-medium">{match.team1} vs {match.team2}</p>
                      <p className="text-gray-500 text-xs mt-0.5">
                        {new Date(match.scheduled_at).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                        {" · "}Match {match.match_number}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${match.status === "abandoned" ? "bg-red-900 text-red-400" : "bg-gray-800 text-gray-400"}`}>
                        {match.status}
                      </span>
                      <p className="text-gray-500 text-xs mt-1">₹{prizePool}</p>
                    </div>
                  </div>

                  {match.status === "completed" && (
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-800">
                      <div className="text-sm">
                        {winner && <span className="text-gray-400">🥇 {winner.users?.name} · {winner.final_points}pts</span>}
                      </div>
                      <div className="text-sm">
                        {myResult ? (
                          <span className={myResult.prize_won > 0 ? "text-yellow-400 font-semibold" : "text-gray-500"}>
                            You: #{myResult.rank} · {myResult.prize_won > 0 ? `+₹${myResult.prize_won}` : `${myResult.final_points}pts`}
                          </span>
                        ) : (
                          <span className="text-gray-600 text-xs">No team</span>
                        )}
                      </div>
                    </div>
                  )}
                  {match.result_announcement && (
                    <p className="text-gray-600 text-xs mt-2 italic">{match.result_announcement}</p>
                  )}
                </div>
              </Link>
            )
          })
        )}
      </main>
    </div>
  )
}
