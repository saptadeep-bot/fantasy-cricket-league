import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("status")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  if (match.status !== "upcoming") {
    return NextResponse.json({ error: "Match is not in upcoming state" }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from("matches")
    .update({ status: "locked" })
    .eq("id", id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
