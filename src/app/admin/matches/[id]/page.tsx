import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import Navbar from "@/components/Navbar"
import LockMatchPanel from "./LockMatchPanel"
import ScoreControls from "./ScoreControls"

export default async function AdminMatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) redirect("/login")
  if (!session.user.is_admin) redirect("/")

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", id)
    .single()

  if (!match) redirect("/admin/matches")

  const { data: players } = await supabaseAdmin
    .from("match_players")
    .select("*")
    .eq("match_id", id)
    .order("team")
    .order("role")

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-white">Match Setup</h1>
          <a href="/admin/matches" className="text-gray-500 text-sm hover:text-white">← Back</a>
        </div>

        {/* Match info */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-6">
          <p className="text-yellow-400 text-xs font-semibold uppercase tracking-wider mb-1">Match {match.match_number}</p>
          <h2 className="text-white font-bold text-lg">{match.team1} vs {match.team2}</h2>
          <p className="text-gray-500 text-sm mt-1">
            {new Date(match.scheduled_at).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" })}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${
              match.status === "locked" ? "bg-blue-900 text-blue-400" :
              match.status === "live" ? "bg-green-900 text-green-400" :
              match.status === "completed" ? "bg-gray-800 text-gray-400" :
              match.status === "abandoned" ? "bg-red-900 text-red-300" :
              "bg-gray-800 text-yellow-400"
            }`}>{match.status}</span>
            <span className="text-gray-500 text-xs">Prize: ₹{match.base_prize + (match.rollover_added || 0)}</span>
          </div>
        </div>

        <LockMatchPanel match={match} existingPlayers={players || []} />
        <div className="mt-6">
          <ScoreControls match={match} />
        </div>
      </main>
    </div>
  )
}
