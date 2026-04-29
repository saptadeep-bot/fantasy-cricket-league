// src/lib/match-scoring.ts
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints, type BreakdownComponent } from "@/lib/fantasy-points"
import { canonicalTeam, teamFromInningLabel } from "@/lib/team-names"

export interface ComputeResult {
  updated: number
  total: number
  remapped: number
  autoAdded: number
  missed: string[]
  // Set when the scorecard's team labels don't canonicalise to match.team1/
  // team2.  We refuse to write — protects against PAK/NZ players' points
  // landing in an IPL match's match_players (2026-04-28 incident, root cause
  // was EntitySport's listing returning a wrong-fixture match_id which got
  // cached and replayed every poll).
  rejectedReason?: string
}

// Detect a Postgrest "points_breakdown column doesn't exist" error so writes
// can transparently degrade if the migration hasn't been run yet.  We don't
// want a live-scoring path to die because the breakdown column is missing —
// fall back to writing only fantasy_points and continue.
function isPointsBreakdownColumnMissing(msg: string | null | undefined): boolean {
  if (!msg) return false
  return /points_breakdown/i.test(msg) && /(column|does not exist|schema cache)/i.test(msg)
}

// ─── Name normalisation & matching ───────────────────────────────────────────
function norm(s: string) {
  return s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim()
}

export function namesMatch(a: string, b: string): boolean {
  const na = norm(a)
  const nb = norm(b)
  if (na === nb) return true

  const pa = na.split(" ")
  const pb = nb.split(" ")

  // Surname (last word) must match
  if (pa[pa.length - 1] !== pb[pb.length - 1]) return false

  const fa = pa[0]
  const fb = pb[0]
  if (fa === fb) return true

  // Single initial: "v" matches "virat"
  if (fa.length === 1 && fb.startsWith(fa)) return true
  if (fb.length === 1 && fa.startsWith(fb)) return true

  // Double/triple initials: "ms" → first letter matches
  if (fa.length <= 3 && fb.length > 3 && fa[0] === fb[0]) return true
  if (fb.length <= 3 && fa.length > 3 && fb[0] === fa[0]) return true

  return false
}

// ─── Extract player→team from scorecard innings ───────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function playerTeamsFromScorecard(scorecard: any[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const inning of scorecard) {
    const inningStr = typeof inning.inning === "string" ? inning.inning : ""
    // "Mumbai Indians Inning 1" → "Mumbai Indians"
    const battingTeam = inningStr.replace(/\s+(Inning|Innings)\s+\d+$/i, "").trim()
    for (const entry of inning.batting || []) {
      const id = (entry.id ?? entry.batsman?.id ?? "") as string
      if (id && !map.has(id)) map.set(id, battingTeam)
    }
  }
  return map
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inferRole(pts: { batting: number; bowling: number }): string {
  if (pts.batting > 0 && pts.bowling > 0) return "ALL"
  if (pts.bowling > 0) return "BOWL"
  return "BAT"
}

// ─── computeAndSave ───────────────────────────────────────────────────────────
// Calculates fantasy points from scorecard and persists to DB.
// Handles: direct ID match, name-fuzzy match (ID remap), auto-insert of unknown players.
export async function computeAndSave(matchId: string, scorecard: unknown[]): Promise<ComputeResult> {
  // Fetch match metadata (scheduled_at — drives SR rule selection; team1/
  // team2 — drives team validation) and the squad (id + name + role — drives
  // ID/name match AND specialist-bowler exemption for the new SR rules).
  // Done up front, in parallel, so the calculator has everything it needs
  // on the first pass.
  const [matchRes, playersRes] = await Promise.all([
    supabaseAdmin.from("matches").select("scheduled_at, team1, team2").eq("id", matchId).single(),
    supabaseAdmin.from("match_players")
      .select("cricketdata_player_id, name, role")
      .eq("match_id", matchId),
  ])

  const matchDate = matchRes.data?.scheduled_at ?? null
  const matchTeam1 = (matchRes.data?.team1 ?? "") as string
  const matchTeam2 = (matchRes.data?.team2 ?? "") as string

  // Team-name guard: refuse to compute if the scorecard's innings don't
  // belong to this match.  Defends against EntitySport returning a wrong-
  // fixture scorecard via a stale cached match_id (the 2026-04-28 incident
  // where PAK/NZ players' points landed in MI vs SRH).  Without this guard,
  // the auto-insert path would happily add foreign players to match_players.
  if (matchTeam1 && matchTeam2) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inningTeams = (scorecard as any[])
      .map(inn => teamFromInningLabel((inn?.inning ?? "").toString()))
      .filter(Boolean)
    const rogue = inningTeams.find(t => !canonicalTeam(t, matchTeam1, matchTeam2))
    if (rogue) {
      return {
        updated: 0,
        total: 0,
        remapped: 0,
        autoAdded: 0,
        missed: [],
        rejectedReason: `scorecard innings team "${rogue}" doesn't match ${matchTeam1} or ${matchTeam2} — refusing to write`,
      }
    }
  }
  const dbList: Array<{ id: string; name: string; role?: string }> = (playersRes.data || []).map(
    (p: { cricketdata_player_id: string; name: string; role?: string }) => ({
      id: p.cricketdata_player_id,
      name: p.name,
      role: p.role,
    }),
  )
  const dbIds = new Set(dbList.map(p => p.id))
  const roleById = new Map<string, string>()
  for (const p of dbList) {
    if (p.role) roleById.set(p.id, p.role)
  }

  // Role lookup for the calculator.  Tries direct ID first; if the scorecard
  // ID hasn't been remapped yet (different from what's in match_players),
  // falls back to fuzzy name match.  This handles the live-poll edge case
  // where cricapi's IDs drift but our squad is named correctly.
  const getRole = (id: string, name: string): "BAT" | "BOWL" | "ALL" | "WK" | undefined => {
    const direct = roleById.get(id)
    if (direct) return direct as "BAT" | "BOWL" | "ALL" | "WK"
    const matched = dbList.find(p => namesMatch(name, p.name))
    return matched?.role as "BAT" | "BOWL" | "ALL" | "WK" | undefined
  }

  const pointsMap = calculateFantasyPoints(scorecard, { matchDate, getRole })
  if (pointsMap.size === 0) {
    return { updated: 0, total: 0, remapped: 0, autoAdded: 0, missed: [] }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const teamMap = playerTeamsFromScorecard(scorecard as any[])

  const now = new Date().toISOString()
  const directUpdates: Array<{ id: string; points: number; breakdown: BreakdownComponent[] }> = []
  const idRemaps: Array<{ oldId: string; newId: string; fantasyPoints: number; breakdown: BreakdownComponent[] }> = []
  const autoInsertPlayers: Array<{
    cricketdata_player_id: string; name: string; team: string; role: string; fantasy_points: number; breakdown: BreakdownComponent[]
  }> = []
  const autoInsertNames: string[] = []

  for (const [playerId, pts] of pointsMap.entries()) {
    const fantasyPoints = Math.round(pts.total * 10) / 10

    if (dbIds.has(playerId)) {
      directUpdates.push({ id: playerId, points: fantasyPoints, breakdown: pts.components })
    } else {
      const matched = dbList.find((p: { id: string; name: string }) => namesMatch(pts.name, p.name))
      if (matched) {
        idRemaps.push({ oldId: matched.id, newId: playerId, fantasyPoints, breakdown: pts.components })
      } else {
        // Truly unknown player — could be a legitimate impact sub (e.g. Linde
        // for LSG) OR a foreign player from a wrong-fixture scorecard (e.g.
        // Babar Azam in an IPL match because EntitySport's listing mapped to
        // a PAK match).  Defence in depth: only auto-insert if the player's
        // team from the scorecard canonicalises to match.team1/team2.  The
        // outer guard at the top of computeAndSave should already have
        // refused on rogue innings, but if a single innings somehow has
        // mixed teams or the team label was empty we catch it here too.
        const playerTeamRaw = teamMap.get(playerId) || ""
        const canonTeam = matchTeam1 && matchTeam2
          ? canonicalTeam(playerTeamRaw, matchTeam1, matchTeam2)
          : playerTeamRaw  // older codepath — no guard
        if (matchTeam1 && matchTeam2 && !canonTeam) {
          // Drop silently — don't pollute match_players with foreign squads.
          continue
        }
        autoInsertPlayers.push({
          cricketdata_player_id: playerId,
          name: pts.name,
          team: canonTeam || playerTeamRaw,
          role: inferRole(pts),
          fantasy_points: fantasyPoints,
          breakdown: pts.components,
        })
        autoInsertNames.push(pts.name)
      }
    }
  }

  // Track whether the points_breakdown column is present.  Optimistic: assume
  // present until a write fails with a column-missing error, at which point
  // we flip to false and skip the field on all remaining writes.  This keeps
  // live scoring functional even if the migration hasn't been applied.
  let pointsBreakdownAvailable = true

  // Parallel direct updates.  Each one tries with points_breakdown; on
  // column-missing it retries without and flips the global flag.
  const directResults = await Promise.all(
    directUpdates.map(async ({ id, points, breakdown }) => {
      const payload: Record<string, unknown> = { fantasy_points: points, last_updated: now }
      if (pointsBreakdownAvailable) payload.points_breakdown = breakdown
      const r = await supabaseAdmin
        .from("match_players")
        .update(payload)
        .eq("match_id", matchId)
        .eq("cricketdata_player_id", id)
      if (r.error && isPointsBreakdownColumnMissing(r.error.message)) {
        pointsBreakdownAvailable = false
        return supabaseAdmin
          .from("match_players")
          .update({ fantasy_points: points, last_updated: now })
          .eq("match_id", matchId)
          .eq("cricketdata_player_id", id)
      }
      return r
    }),
  )
  const updated = directResults.filter((r: { error: unknown }) => !r.error).length

  // Name-based remaps: correct stored ID and save points + breakdown.
  // Deduplicate by oldId first — an all-rounder can appear twice in pointsMap
  // (once as batsman cb_ID_A, once as bowler cb_ID_B) but both name-match the
  // same DB row whose current ID is oldId.  The first remap changes the DB row's
  // cricketdata_player_id to cb_ID_A; the second then finds no row with oldId and
  // the bowling points are silently lost.  Fix: merge all remaps for the same
  // oldId into a single update with summed fantasy points AND concatenated
  // breakdown components.
  const mergedRemaps = new Map<string, { oldId: string; newId: string; fantasyPoints: number; breakdown: BreakdownComponent[] }>()
  for (const remap of idRemaps) {
    if (mergedRemaps.has(remap.oldId)) {
      const existing = mergedRemaps.get(remap.oldId)!
      existing.fantasyPoints += remap.fantasyPoints
      existing.breakdown = [...existing.breakdown, ...remap.breakdown]
    } else {
      mergedRemaps.set(remap.oldId, { ...remap, breakdown: [...remap.breakdown] })
    }
  }

  let remapped = 0
  for (const { oldId, newId, fantasyPoints, breakdown } of mergedRemaps.values()) {
    const payload: Record<string, unknown> = {
      cricketdata_player_id: newId,
      fantasy_points: fantasyPoints,
      last_updated: now,
    }
    if (pointsBreakdownAvailable) payload.points_breakdown = breakdown
    const r = await supabaseAdmin
      .from("match_players")
      .update(payload)
      .eq("match_id", matchId)
      .eq("cricketdata_player_id", oldId)
    if (r.error && isPointsBreakdownColumnMissing(r.error.message)) {
      pointsBreakdownAvailable = false
      const retryPayload: Record<string, unknown> = {
        cricketdata_player_id: newId,
        fantasy_points: fantasyPoints,
        last_updated: now,
      }
      const retry = await supabaseAdmin
        .from("match_players")
        .update(retryPayload)
        .eq("match_id", matchId)
        .eq("cricketdata_player_id", oldId)
      if (!retry.error) remapped++
    } else if (!r.error) {
      remapped++
    }
  }

  // Also fix up the idRemaps array so the team-repair loop below uses the merged list
  const deduplicatedRemaps = Array.from(mergedRemaps.values())

  // Repair team player_ids / captain / vc that used old IDs
  if (deduplicatedRemaps.length > 0) {
    const { data: teamsData } = await supabaseAdmin
      .from("teams")
      .select("id, player_ids, captain_id, vice_captain_id")
      .eq("match_id", matchId)

    for (const team of (teamsData || [])) {
      let changed = false
      let playerIds: string[] = team.player_ids || []
      let captainId: string = team.captain_id
      let vcId: string = team.vice_captain_id

      for (const { oldId, newId } of deduplicatedRemaps) {
        if (playerIds.includes(oldId)) {
          playerIds = playerIds.map((pid: string) => (pid === oldId ? newId : pid))
          changed = true
        }
        if (captainId === oldId) { captainId = newId; changed = true }
        if (vcId === oldId) { vcId = newId; changed = true }
      }

      if (changed) {
        await supabaseAdmin
          .from("teams")
          .update({ player_ids: playerIds, captain_id: captainId, vice_captain_id: vcId })
          .eq("id", team.id)
      }
    }
  }

  // Auto-insert truly unknown players (impact subs like Linde not in original squad).
  //
  // Resilient to schema drift: if the `is_substitute` column hasn't been
  // added to match_players yet (migration lag), retry the insert with that
  // field stripped rather than losing the player's points entirely.  Missing
  // the sub-flag is cosmetic; missing the points row means their fantasy
  // points are lost permanently for this match.
  let autoAdded = 0
  const missed: string[] = []
  if (autoInsertPlayers.length > 0) {
    const buildRows = (includeBreakdown: boolean, includeSub: boolean) =>
      autoInsertPlayers.map(p => {
        const row: Record<string, unknown> = {
          match_id: matchId,
          cricketdata_player_id: p.cricketdata_player_id,
          name: p.name,
          team: p.team,
          role: p.role,
          is_playing: true,
          fantasy_points: p.fantasy_points,
          last_updated: now,
        }
        if (includeSub) row.is_substitute = true
        if (includeBreakdown) row.points_breakdown = p.breakdown
        return row
      })

    let rows = buildRows(pointsBreakdownAvailable, true)
    let r = await supabaseAdmin.from("match_players").insert(rows)
    // Retry without points_breakdown if that column is missing.
    if (r.error && isPointsBreakdownColumnMissing(r.error.message)) {
      pointsBreakdownAvailable = false
      rows = buildRows(false, true)
      r = await supabaseAdmin.from("match_players").insert(rows)
    }
    // Retry without is_substitute if THAT column is missing (legacy schema).
    if (r.error) {
      const msg = r.error.message || ""
      const subMissing = /is_substitute/i.test(msg) && /column|does not exist|schema cache/i.test(msg)
      if (subMissing) {
        rows = buildRows(pointsBreakdownAvailable, false)
        r = await supabaseAdmin.from("match_players").insert(rows)
      }
    }
    if (!r.error) {
      autoAdded = autoInsertPlayers.length
    } else {
      missed.push(...autoInsertNames)
    }
  }

  return { updated: updated + remapped, total: pointsMap.size, remapped, autoAdded, missed }
}
