import { auth } from "@/auth"
import { redirect } from "next/navigation"
import Navbar from "@/components/Navbar"
import { supabaseAdmin } from "@/lib/supabase"

export default async function AdminUsersPage() {
  const session = await auth()
  if (!session) redirect("/login")
  if (!session.user.is_admin) redirect("/")

  const { data: users } = await supabaseAdmin
    .from("users")
    .select("*")
    .order("created_at")

  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-white">Player Management</h1>
          <a href="/admin" className="text-gray-500 text-sm hover:text-white">← Back</a>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-6">
          <h2 className="font-semibold text-white mb-4">Add a Player</h2>
          <form action="/api/admin/users" method="POST" className="space-y-3">
            <input name="name" placeholder="Full name" required
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-2.5 text-sm border border-gray-700 focus:outline-none focus:border-yellow-400" />
            <input name="email" type="email" placeholder="Gmail address" required
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-2.5 text-sm border border-gray-700 focus:outline-none focus:border-yellow-400" />
            <label className="flex items-center gap-2 text-sm text-gray-400">
              <input type="checkbox" name="is_admin" className="accent-yellow-400" />
              Make admin
            </label>
            <button type="submit"
              className="bg-yellow-400 text-gray-900 font-semibold px-4 py-2 rounded-xl text-sm hover:bg-yellow-300 transition">
              Add Player
            </button>
          </form>
        </div>

        <div className="space-y-3">
          {users?.map((u) => (
            <div key={u.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-white font-medium">{u.name}</p>
                <p className="text-gray-500 text-sm">{u.email}</p>
              </div>
              <div className="flex items-center gap-2">
                {u.is_admin && <span className="text-xs bg-yellow-400 text-gray-900 px-2 py-0.5 rounded-full font-semibold">Admin</span>}
                {u.google_id ? <span className="text-xs text-green-400">✓ Linked</span> : <span className="text-xs text-gray-600">Not logged in yet</span>}
              </div>
            </div>
          ))}
          {(!users || users.length === 0) && (
            <p className="text-gray-500 text-sm">No players added yet. Add all 5 friends above.</p>
          )}
        </div>
      </main>
    </div>
  )
}
