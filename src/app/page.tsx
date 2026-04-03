import { auth } from "@/auth"
import { redirect } from "next/navigation"
import Navbar from "@/components/Navbar"
import { supabaseAdmin } from "@/lib/supabase"

export default async function HomePage() {
  const session = await auth()
  if (!session) redirect("/login")

  // Fetch next 4 upcoming/active matches
  const { data: upcomingMatches } = await supabaseAdmin
    .from("matches")
    .select("*")
    .in("status", ["upcoming", "locked", "live"])
    .order("scheduled_at", { ascending: true })
    .limit(4)

  const nextMatch = upcomingMatches?.[0] ?? null

  // Check if current user has a team for the next match
  const { data: myNextTeam } = nextMatch
    ? await supabaseAdmin
        .from("teams")
        .select("id")
        .eq("match_id", nextMatch.id)
        .eq("user_id", session.user.id)
        .maybeSingle()
    : { data: null }

  // Fetch last completed match with results
  const { data: lastMatch } = await supabaseAdmin
    .from("matches")
    .select("*, match_results(*, users(name))")
    .eq("status", "completed")
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .single()

  // Fetch real season reserve total
  const { data: reserveData } = await supabaseAdmin
    .from("season_reserve")
    .select("amount")
  const totalReserve = reserveData?.reduce((sum, r) => sum + (r.amount || 0), 0) || 0

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Welcome */}
        <div>
          <h1 className="text-xl font-bold text-white">
            Welcome, {session.user.name?.split(" ")[0]} 👋
          </h1>
          <p className="text-gray-500 text-sm">IPL 2026 Fantasy League</p>
        </div>

        {/* Next Match Card */}
        {nextMatch ? (
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">
                {nextMatch.status === "live" ? "🔴 Live Now" :
                 nextMatch.status === "locked" ? "🔒 Locked" : "⏳ Upcoming"}
              </span>
              <span className="text-xs text-gray-500">
                Match {nextMatch.match_number} · {nextMatch.match_type.toUpperCase()}
              </span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-lg font-bold text-white">{nextMatch.team1}</span>
              <span className="text-gray-600 font-medium">vs</span>
              <span className="text-lg font-bold text-white">{nextMatch.team2}</span>
            </div>
            <p className="text-gray-500 text-xs mb-4">
              {new Date(nextMatch.scheduled_at).toLocaleString("en-IN", {
                dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata"
              })} · {nextMatch.venue}
            </p>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">
                💰 Prize Pool: <span className="text-yellow-400 font-semibold">₹{nextMatch.base_prize + (nextMatch.rollover_added || 0)}</span>
              </span>
              {nextMatch.status === "upcoming" ? (
                <a
                  href={`/match/${nextMatch.id}/team`}
                  className="bg-yellow-400 text-gray-900 font-semibold text-sm px-4 py-2 rounded-xl hover:bg-yellow-300 transition"
                >
                  Pick Team →
                </a>
              ) : nextMatch.status === "locked" ? (
                <a
                  href={`/match/${nextMatch.id}/team`}
                  className="bg-yellow-400 text-gray-900 font-semibold text-sm px-4 py-2 rounded-xl hover:bg-yellow-300 transition"
                >
                  {myNextTeam ? "Edit Team →" : "Pick Team →"}
                </a>
              ) : nextMatch.status === "live" ? (
                <a
                  href={`/match/${nextMatch.id}`}
                  className="bg-green-500 text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-green-400 transition"
                >
                  View Live →
                </a>
              ) : nextMatch.status === "completed" ? (
                <a
                  href={`/match/${nextMatch.id}`}
                  className="bg-gray-700 text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-gray-600 transition"
                >
                  View Results →
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-center text-gray-500">
            No upcoming matches. Season may not have started yet.
          </div>
        )}

        {/* Upcoming Matches */}
        {upcomingMatches && upcomingMatches.length > 1 && (
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Coming Up</h2>
            <div className="space-y-3">
              {upcomingMatches.slice(1).map(m => (
                <div key={m.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-white text-sm font-medium">{m.team1} vs {m.team2}</p>
                    <p className="text-gray-500 text-xs">
                      {new Date(m.scheduled_at).toLocaleString("en-IN", {
                        dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata"
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-yellow-400 text-xs font-semibold">₹{m.base_prize + (m.rollover_added || 0)}</p>
                    <p className="text-gray-600 text-xs">M{m.match_number}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Last Match Result */}
        {lastMatch && (
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Last Match</h2>
            <p className="text-white font-medium mb-1">{lastMatch.name}</p>
            {lastMatch.result_announcement && (
              <p className="text-gray-400 text-sm mb-3">{lastMatch.result_announcement}</p>
            )}
            {lastMatch.match_results?.length > 0 && (
              <div className="space-y-2">
                {lastMatch.match_results
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .sort((a: any, b: any) => a.rank - b.rank)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((r: any) => (
                    <div key={r.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">
                          {r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : ""}
                        </span>
                        <span className="text-sm text-white">{r.users?.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-gray-400">{r.final_points} pts</span>
                        {r.prize_won > 0 && (
                          <span className="text-sm text-yellow-400 font-semibold">+₹{r.prize_won}</span>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* Season Reserve Teaser */}
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-400">Season Reserve Pot</p>
            <p className="text-xs text-gray-600">Awarded to top 2 at season end</p>
          </div>
          <span className="text-yellow-400 font-bold text-lg">₹{totalReserve}</span>
        </div>
      </main>
    </div>
  )
}
