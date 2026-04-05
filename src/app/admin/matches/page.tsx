import { auth } from "@/auth"
import { redirect } from "next/navigation"
import Navbar from "@/components/Navbar"
import { supabaseAdmin } from "@/lib/supabase"
import ImportMatchesButton from "./ImportMatchesButton"

export default async function AdminMatchesPage() {
  const session = await auth()
  if (!session) redirect("/login")
  if (!session.user.is_admin) redirect("/")

  const { data: matches } = await supabaseAdmin
    .from("matches")
    .select("*")
    .not("status", "eq", "completed")
    .order("scheduled_at", { ascending: true })

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-white">Match Management</h1>
          <a href="/admin" className="text-gray-500 text-sm hover:text-white">← Back</a>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-6">
          <h2 className="font-semibold text-white mb-2">Import IPL 2026 Schedule</h2>
          <p className="text-gray-500 text-sm mb-4">Fetches all 70 matches from cricketdata.org and saves them to the database.</p>
          <ImportMatchesButton />
        </div>

        <div className="space-y-2">
          {matches?.map((m) => (
            <a key={m.id} href={`/admin/matches/${m.id}`} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between hover:border-gray-600 transition block">
              <div>
                <p className="text-white text-sm font-medium">{m.name}</p>
                <p className="text-gray-500 text-xs">
                  {new Date(m.scheduled_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
                  {" · "}₹{m.base_prize + (m.rollover_added || 0)}
                </p>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                m.status === "live" ? "bg-green-900 text-green-400" :
                m.status === "completed" ? "bg-gray-800 text-gray-400" :
                m.status === "abandoned" ? "bg-red-900 text-red-400" :
                m.status === "locked" ? "bg-blue-900 text-blue-400" :
                "bg-gray-800 text-yellow-400"
              }`}>
                {m.status}
              </span>
            </a>
          ))}
          {(!matches || matches.length === 0) && (
            <p className="text-gray-500 text-sm">No matches yet. Click &quot;Import&quot; above.</p>
          )}
        </div>
      </main>
    </div>
  )
}
