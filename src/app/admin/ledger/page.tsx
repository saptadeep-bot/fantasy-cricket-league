import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import Navbar from "@/components/Navbar"
import SettleButton from "./SettleButton"

export const revalidate = 0

export default async function AdminLedgerPage() {
  const session = await auth()
  if (!session) redirect("/login")
  if (!session.user.is_admin) redirect("/")

  const { data: results } = await supabaseAdmin
    .from("match_results")
    .select("*, matches(name, match_number, scheduled_at), users(name)")
    .gt("prize_won", 0)
    .order("created_at", { ascending: false })

  const pending = results?.filter(r => !r.is_settled) || []
  const settled = results?.filter(r => r.is_settled) || []

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-white">Admin · Payout Ledger</h1>
          <a href="/admin" className="text-gray-500 text-sm hover:text-white">← Back</a>
        </div>

        {/* Pending settlements */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-4">
            Pending Payouts
            {pending.length > 0 && <span className="ml-2 text-xs bg-red-900 text-red-400 px-2 py-0.5 rounded-full">{pending.length}</span>}
          </h2>
          {pending.length === 0 ? (
            <p className="text-gray-500 text-sm">All payouts settled!</p>
          ) : (
            <div className="space-y-3">
              {pending.map(r => (
                <div key={r.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-white text-sm font-medium">{r.users?.name}</p>
                    <p className="text-gray-500 text-xs">
                      {r.matches?.name} · #{r.rank}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-yellow-400 font-bold">₹{r.prize_won}</span>
                    <SettleButton resultId={r.id} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Settled */}
        {settled.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="text-white font-semibold mb-4">Settled ✓</h2>
            <div className="space-y-2">
              {settled.map(r => (
                <div key={r.id} className="flex items-center justify-between text-sm opacity-60">
                  <p className="text-white">{r.users?.name} · {r.matches?.name}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400">₹{r.prize_won}</span>
                    <span className="text-green-500 text-xs">✓</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>
    </div>
  )
}
