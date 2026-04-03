import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { status, announcement } = await req.json()
  const validStatuses = ["upcoming", "locked", "live", "completed", "abandoned"]
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 })
  }

  const updateData: Record<string, string> = { status }
  if (announcement) updateData.result_announcement = announcement

  // If marking abandoned, rollover prize to next match
  if (status === "abandoned") {
    const { data: match } = await supabaseAdmin
      .from("matches")
      .select("base_prize, rollover_added")
      .eq("id", id)
      .single()

    if (match) {
      const { data: nextMatch } = await supabaseAdmin
        .from("matches")
        .select("id, rollover_added")
        .eq("status", "upcoming")
        .order("scheduled_at", { ascending: true })
        .limit(1)
        .single()

      if (nextMatch) {
        await supabaseAdmin
          .from("matches")
          .update({ rollover_added: (nextMatch.rollover_added || 0) + match.base_prize + (match.rollover_added || 0) })
          .eq("id", nextMatch.id)
      }
    }
  }

  const { error } = await supabaseAdmin.from("matches").update(updateData).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
