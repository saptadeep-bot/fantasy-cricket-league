import { auth } from "@/auth"
import { redirect } from "next/navigation"
import Navbar from "@/components/Navbar"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

function getEntryFee(matchType: string): number {
  const type = (matchType || "league").toLowerCase()
  if (type === "final") return 500
  if (type === "eliminator" || type === "qualifier" || type.includes("qualifier") || type.includes("eliminator")) return 350
  return 250
}

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

  const secondMatch = upcomingMatches?.[1] ?? null

  // Fetch all users in the league
  const { data: allUsers } = await supabaseAdmin
    .from("users")
    .select("id, name")

  // Fetch all submitted teams for upcoming matches in one query
  const upcomingIds = (upcomingMatches || []).map(m => m.id)
  const { data: allUpcomingTeams } = upcomingIds.length > 0
    ? await supabaseAdmin
        .from("teams")
        .select("match_id, user_id")
        .in("match_id", upcomingIds)
    : { data: [] }

  // Helper: get first names of who has/hasn't submitted for a match
  function getSubmissionStatus(matchId: string) {
    const submittedUserIds = new Set((allUpcomingTeams || []).filter(t => t.match_id === matchId).map(t => t.user_id))
    const done = (allUsers || []).filter(u => submittedUserIds.has(u.id)).map(u => u.name.split(" ")[0])
    const pending = (allUsers || []).filter(u => !submittedUserIds.has(u.id)).map(u => u.name.split(" ")[0])
    return { done, pending }
  }

  const myNextTeam = nextMatch ? (allUpcomingTeams || []).find(t => t.match_id === nextMatch.id && t.user_id === session.user.id) : null
  const mySecondTeam = secondMatch ? (allUpcomingTeams || []).find(t => t.match_id === secondMatch.id && t.user_id === session.user.id) : null

  // Fetch last completed match with results
  const { data: lastMatch } = await supabaseAdmin
    .from("matches")
    .select("*, match_results(*, users(name))")
    .eq("status", "completed")
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .single()

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
            {/* Who has submitted */}
            {(() => {
              const { done, pending } = getSubmissionStatus(nextMatch.id)
              return (done.length > 0 || pending.length > 0) ? (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {done.map(name => (
                    <span key={name} className="text-xs bg-green-900/40 text-green-400 border border-green-800/50 px-2 py-0.5 rounded-full">✓ {name}</span>
                  ))}
                  {pending.map(name => (
                    <span key={name} className="text-xs bg-gray-800 text-gray-500 border border-gray-700 px-2 py-0.5 rounded-full">{name}</span>
                  ))}
                </div>
              ) : null
            })()}

            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">
                💰 Entry: <span className="text-yellow-400 font-semibold">₹{getEntryFee(nextMatch.match_type)}/person</span>
                <span className="text-gray-600 text-xs ml-2">Pool: ₹{getEntryFee(nextMatch.match_type) * (allUsers?.length || 0)}</span>
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
              {upcomingMatches.slice(1).map((m, idx) => {
                const isSecond = idx === 0
                const hasTeam = isSecond ? !!mySecondTeam : false
                const canPick = isSecond && m.status === "upcoming"
                return (
                  <div key={m.id} className={`${isSecond ? "pb-3 border-b border-gray-800" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white text-sm font-medium">{m.team1} vs {m.team2}</p>
                        <p className="text-gray-500 text-xs">
                          {new Date(m.scheduled_at).toLocaleString("en-IN", {
                            dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata"
                          })}
                        </p>
                        <p className="text-gray-600 text-xs">M{m.match_number} · Entry ₹{getEntryFee(m.match_type)}</p>
                      </div>
                      {canPick ? (
                        <a
                          href={`/match/${m.id}/team`}
                          className="bg-yellow-400/10 border border-yellow-400/40 text-yellow-400 text-xs font-semibold px-3 py-1.5 rounded-xl hover:bg-yellow-400/20 transition whitespace-nowrap"
                        >
                          {hasTeam ? "Edit →" : "Pick →"}
                        </a>
                      ) : (
                        <p className="text-yellow-400 text-xs font-semibold">₹{getEntryFee(m.match_type)}/person</p>
                      )}
                    </div>
                    {(() => {
                      const { done, pending } = getSubmissionStatus(m.id)
                      return (done.length > 0 || pending.length > 0) ? (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {done.map(name => (
                            <span key={name} className="text-xs bg-green-900/40 text-green-400 border border-green-800/50 px-2 py-0.5 rounded-full">✓ {name}</span>
                          ))}
                          {pending.map(name => (
                            <span key={name} className="text-xs bg-gray-800 text-gray-500 border border-gray-700 px-2 py-0.5 rounded-full">{name}</span>
                          ))}
                        </div>
                      ) : null
                    })()}
                  </div>
                )
              })}
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

      </main>
    </div>
  )
}
