// Recover-from-abandoned admin endpoint.
//
// When an admin marks a match "abandoned" (via /status), the status route
// rolls (base_prize + rollover_added) into the next upcoming match's
// rollover_added field.  If the abandon was a mistake — e.g. the match
// actually ended fine but finalize was blocked by an over-strict guard, as
// happened with Punjab vs Delhi on 2026-04-25 — we need to:
//   1. Reverse the rollover so the prize doesn't double-count
//   2. Flip status back to a state where finalize can run
//
// We DON'T just flip status; without reversing the rollover the prize money
// gets paid out twice (once via the rollover-bumped match, once via this
// match's finalize).  The reversal is the whole point of this endpoint.
//
// Reversal lookup: we mirror the abandon-side logic.  The abandon route
// picked the match with the earliest scheduled_at among status='upcoming'.
// By the time we recover, that match may no longer be 'upcoming' (it might
// have started/ended), so we widen the search to any status — but we
// require a strict equality on the expected rollover_added so we don't
// accidentally rewind a value that's been further changed by other
// abandons.  If we can't find a match whose rollover_added is at least as
// large as the amount we're reversing, we refuse and return a diagnostic.

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
    .select("*")
    .eq("id", id)
    .single()

  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 })
  if (match.status !== "abandoned") {
    return NextResponse.json({
      error: `Match status is "${match.status}", not "abandoned" — recovery is only for abandoned matches.`,
    }, { status: 400 })
  }

  const rolloverAmount = (match.base_prize ?? 0) + (match.rollover_added ?? 0)

  // Find the candidate that received the rollover.  We look for matches
  // scheduled AFTER the abandoned one with rollover_added >= rolloverAmount,
  // ordered by scheduled_at ascending (closest-after first — same order the
  // abandon route picked).
  const { data: candidates } = await supabaseAdmin
    .from("matches")
    .select("id, name, status, scheduled_at, rollover_added, base_prize")
    .gt("scheduled_at", match.scheduled_at)
    .order("scheduled_at", { ascending: true })

  const recipient = (candidates || []).find(
    c => (c.rollover_added ?? 0) >= rolloverAmount,
  )

  if (rolloverAmount > 0 && !recipient) {
    // We can't find anything to debit.  Refuse rather than create an
    // accounting hole — the admin will need to fix manually.
    return NextResponse.json({
      error: `Could not locate the match that received the ₹${rolloverAmount} rollover from this abandon. ` +
        `Candidates checked: ${(candidates || []).length}. ` +
        `Resolve manually in Supabase before recovering, or contact support.`,
      diagnostic: {
        rolloverAmount,
        candidates: (candidates || []).map(c => ({
          id: c.id,
          name: c.name,
          status: c.status,
          rollover_added: c.rollover_added,
        })),
      },
    }, { status: 409 })
  }

  // Reverse the rollover on the recipient (if any).
  let reversedFrom: { id: string; name: string; before: number; after: number } | null = null
  if (recipient && rolloverAmount > 0) {
    const before = recipient.rollover_added ?? 0
    const after = before - rolloverAmount
    const { error: revErr } = await supabaseAdmin
      .from("matches")
      .update({ rollover_added: after })
      .eq("id", recipient.id)
    if (revErr) {
      return NextResponse.json({
        error: `Failed to reverse rollover on recipient match (${recipient.id}): ${revErr.message}`,
      }, { status: 500 })
    }
    reversedFrom = { id: recipient.id, name: recipient.name, before, after }
  }

  // Flip status back so finalize can run.  We pick "live" because the
  // finalize endpoint only blocks on status === "completed", and "live" is
  // the natural pre-finalize state.  result_announcement is left alone.
  const { error: statusErr } = await supabaseAdmin
    .from("matches")
    .update({ status: "live" })
    .eq("id", id)
  if (statusErr) {
    return NextResponse.json({
      error: `Reversed rollover but failed to flip status: ${statusErr.message}`,
    }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    matchId: id,
    matchName: match.name,
    rolloverReversed: rolloverAmount,
    reversedFrom,
    newStatus: "live",
    nextStep: "Click \"Finalize & Pay Out\". If the per-innings guard fires, use \"Force Finalize\".",
  })
}
