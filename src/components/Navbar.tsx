"use client"
import Link from "next/link"
import { useSession, signOut } from "next-auth/react"
import { usePathname } from "next/navigation"

export default function Navbar() {
  const { data: session } = useSession()
  const pathname = usePathname()

  const links = [
    { href: "/", label: "Home" },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/history", label: "History" },
    { href: "/ledger", label: "Ledger" },
    ...(session?.user?.is_admin ? [{ href: "/admin", label: "Admin" }] : []),
  ]

  return (
    <nav className="bg-gray-900 border-b border-gray-800 sticky top-0 z-50">
      <div className="max-w-2xl mx-auto px-4 flex items-center justify-between h-14">
        <Link href="/" className="font-bold text-yellow-400 text-lg">🏏 FCL</Link>
        <div className="flex items-center gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                pathname === l.href
                  ? "bg-yellow-400 text-gray-900"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <button
            onClick={() => signOut()}
            className="ml-2 text-gray-500 hover:text-red-400 text-sm"
          >
            Out
          </button>
        </div>
      </div>
    </nav>
  )
}
