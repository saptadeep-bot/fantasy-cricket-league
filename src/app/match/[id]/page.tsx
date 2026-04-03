import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import Navbar from "@/components/Navbar"
import LiveMatchView from "./LiveMatchView"

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) redirect("/login")

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", id)
    .single()

  if (!match) redirect("/")

  // Get all teams for this match with user info
  const { data: teams } = await supabaseAdmin
    .from("teams")
    .select("*, users(id, name)")
    .eq("match_id", id)

  // Get match players with points
  const { data: players } = await supabaseAdmin
    .from("match_players")
    .select("*")
    .eq("match_id", id)

  // Get results if completed
  const { data: results } = await supabaseAdmin
    .from("match_results")
    .select("*, users(name)")
    .eq("match_id", id)
    .order("rank")

  // Get current user's team
  const myTeam = teams?.find(t => t.user_id === session.user.id)

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        {/* Match header */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              match.status === "live" ? "bg-green-500 text-white animate-pulse" :
              match.status === "completed" ? "bg-gray-700 text-gray-300" :
              "bg-yellow-900 text-yellow-400"
            }`}>
              {match.status === "live" ? "LIVE" : match.status.toUpperCase()}
            </span>
            <span className="text-gray-500 text-xs">Match {match.match_number}</span>
          </div>
          <h1 className="text-xl font-bold text-white">{match.team1} vs {match.team2}</h1>
          <p className="text-gray-500 text-sm mt-1">
            Prize Pool: <span className="text-yellow-400 font-semibold">₹{(match.base_prize || 0) + (match.rollover_added || 0)}</span>
          </p>
        </div>

        <LiveMatchView
          match={match}
          teams={teams || []}
          players={players || []}
          results={results || []}
          myTeam={myTeam || null}
          currentUserId={session.user.id}
        />
      </main>
    </div>
  )
}
