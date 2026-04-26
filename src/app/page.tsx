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
  // Capture user id outside the closure below — TS doesn't narrow `session`
  // through nested function scopes.
  const userId = session.user.id

  // Fetch next 6 upcoming/locked/live matches.  We bumped the limit from 4
  // to 6 so two simultaneous live matches don't crowd out the next two
  // pickable upcoming ones in the same fetch.
  const { data: activeMatches } = await supabaseAdmin
    .from("matches")
    .select("*")
    .in("status", ["upcoming", "locked", "live"])
    .order("scheduled_at", { ascending: true })
    .limit(6)

  // Split by status.  Multiple live matches can run simultaneously on
  // double-header days — surface ALL of them in their own section instead
  // of only featuring the first one as a single hero card (the old layout
  // hid the second live match entirely until the first finished).
  const liveMatches = (activeMatches || []).filter(m => m.status === "live")
  const pickableMatches = (activeMatches || []).filter(m => m.status === "upcoming" || m.status === "locked")
  // Hero spot — the next match the user can actually act on (pick / edit
  // their team).  Falls back to first activeMatch if there are no
  // pickables (everything is live).
  const heroMatch = pickableMatches[0] ?? activeMatches?.[0] ?? null
  const remainingPickables = pickableMatches.slice(1)

  // Fetch all users in the league
  const { data: allUsers } = await supabaseAdmin
    .from("users")
    .select("id, name")

  // Fetch all submitted teams for active matches in one query
  const activeIds = (activeMatches || []).map(m => m.id)
  const { data: allActiveTeams } = activeIds.length > 0
    ? await supabaseAdmin
        .from("teams")
        .select("match_id, user_id")
        .in("match_id", activeIds)
    : { data: [] }

  // Helper: get first names of who has/hasn't submitted for a match
  function getSubmissionStatus(matchId: string) {
    const submittedUserIds = new Set((allActiveTeams || []).filter(t => t.match_id === matchId).map(t => t.user_id))
    const done = (allUsers || []).filter(u => submittedUserIds.has(u.id)).map(u => u.name.split(" ")[0])
    const pending = (allUsers || []).filter(u => !submittedUserIds.has(u.id)).map(u => u.name.split(" ")[0])
    return { done, pending }
  }

  // Per-card team lookup — replaces the old "myNextTeam / mySecondTeam"
  // pattern that hardcoded the first two activeMatches.  Now any card can
  // ask whether the current user has a team for that specific match.
  function userHasTeam(matchId: string): boolean {
    return !!(allActiveTeams || []).find(t => t.match_id === matchId && t.user_id === userId)
  }

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

        {/* Live Now — own section so multiple simultaneous live matches
            (double-header days) all stay visible.  Each card is independent;
            users can jump into either match's live scoring without waiting
            for the first to finish. */}
        {liveMatches.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-red-400 flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
              Live Now ({liveMatches.length})
            </h2>
            {liveMatches.map(m => (
              <div key={m.id} className="bg-gray-900 rounded-2xl p-5 border border-red-900/60">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-red-400">🔴 Live</span>
                  <span className="text-xs text-gray-500">
                    Match {m.match_number} · {m.match_type.toUpperCase()}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-lg font-bold text-white">{m.team1}</span>
                  <span className="text-gray-600 font-medium">vs</span>
                  <span className="text-lg font-bold text-white">{m.team2}</span>
                </div>
                <p className="text-gray-500 text-xs mb-4">
                  {new Date(m.scheduled_at).toLocaleString("en-IN", {
                    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata"
                  })} · {m.venue}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">
                    💰 Pool: <span className="text-yellow-400 font-semibold">₹{getEntryFee(m.match_type) * (allUsers?.length || 0)}</span>
                  </span>
                  <a
                    href={`/match/${m.id}`}
                    className="bg-green-500 text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-green-400 transition"
                  >
                    View Live →
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Hero — next pickable match (or first active match if everything
            is already live).  This is what the user can take action on next. */}
        {heroMatch ? (
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">
                {heroMatch.status === "live" ? "🔴 Live Now" :
                 heroMatch.status === "locked" ? "🔒 Locked" : "⏳ Upcoming"}
              </span>
              <span className="text-xs text-gray-500">
                Match {heroMatch.match_number} · {heroMatch.match_type.toUpperCase()}
              </span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-lg font-bold text-white">{heroMatch.team1}</span>
              <span className="text-gray-600 font-medium">vs</span>
              <span className="text-lg font-bold text-white">{heroMatch.team2}</span>
            </div>
            <p className="text-gray-500 text-xs mb-4">
              {new Date(heroMatch.scheduled_at).toLocaleString("en-IN", {
                dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata"
              })} · {heroMatch.venue}
            </p>
            {/* Who has submitted */}
            {(() => {
              const { done, pending } = getSubmissionStatus(heroMatch.id)
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
                💰 Entry: <span className="text-yellow-400 font-semibold">₹{getEntryFee(heroMatch.match_type)}/person</span>
                <span className="text-gray-600 text-xs ml-2">Pool: ₹{getEntryFee(heroMatch.match_type) * (allUsers?.length || 0)}</span>
              </span>
              {heroMatch.status === "upcoming" ? (
                <a
                  href={`/match/${heroMatch.id}/team`}
                  className="bg-yellow-400 text-gray-900 font-semibold text-sm px-4 py-2 rounded-xl hover:bg-yellow-300 transition"
                >
                  {userHasTeam(heroMatch.id) ? "Edit Team →" : "Pick Team →"}
                </a>
              ) : heroMatch.status === "locked" ? (
                <a
                  href={`/match/${heroMatch.id}/team`}
                  className="bg-yellow-400 text-gray-900 font-semibold text-sm px-4 py-2 rounded-xl hover:bg-yellow-300 transition"
                >
                  {userHasTeam(heroMatch.id) ? "Edit Team →" : "Pick Team →"}
                </a>
              ) : heroMatch.status === "live" ? (
                <a
                  href={`/match/${heroMatch.id}`}
                  className="bg-green-500 text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-green-400 transition"
                >
                  View Live →
                </a>
              ) : null}
            </div>
          </div>
        ) : liveMatches.length === 0 && (
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-center text-gray-500">
            No upcoming matches. Season may not have started yet.
          </div>
        )}

        {/* Coming Up — remaining pickable matches.  Per-card team lookup
            (no more "first / second match" hardcoding), so users can edit
            their team for any future match shown here. */}
        {remainingPickables.length > 0 && (
          <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Coming Up</h2>
            <div className="space-y-3">
              {remainingPickables.map((m, idx) => {
                const hasTeam = userHasTeam(m.id)
                const canPick = m.status === "upcoming" || m.status === "locked"
                const isLast = idx === remainingPickables.length - 1
                return (
                  <div key={m.id} className={`${!isLast ? "pb-3 border-b border-gray-800" : ""}`}>
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
