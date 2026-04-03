import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import Navbar from "@/components/Navbar"
import TeamPicker from "./TeamPicker"

export default async function TeamSelectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session) redirect("/login")

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("id", id)
    .single()

  if (!match) redirect("/")

  // Check if team selection is allowed
  if (!["upcoming", "locked"].includes(match.status)) {
    redirect(`/match/${id}`)
  }

  const { data: players } = await supabaseAdmin
    .from("match_players")
    .select("*")
    .eq("match_id", id)
    .order("team")
    .order("role")

  // Fetch user's existing team if any
  const { data: existingTeam } = await supabaseAdmin
    .from("teams")
    .select("*")
    .eq("match_id", id)
    .eq("user_id", session.user.id)
    .single()

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        <div className="mb-4">
          <p className="text-yellow-400 text-xs font-semibold uppercase tracking-wider">Match {match.match_number}</p>
          <h1 className="text-xl font-bold text-white">{match.team1} vs {match.team2}</h1>
          <p className="text-gray-500 text-sm">
            {new Date(match.scheduled_at).toLocaleString("en-IN", {
              dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata"
            })} · Prize: ₹{match.base_prize + (match.rollover_added || 0)}
          </p>
        </div>

        {players && players.length > 0 ? (
          <TeamPicker
            matchId={id}
            match={match}
            players={players}
            existingTeam={existingTeam}
          />
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-gray-500">Playing XI not announced yet.</p>
            <p className="text-gray-600 text-sm mt-1">Check back after the toss.</p>
          </div>
        )}
      </main>
    </div>
  )
}
