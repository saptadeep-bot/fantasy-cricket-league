// src/lib/match-scoring.ts
import { supabaseAdmin } from "@/lib/supabase"
import { calculateFantasyPoints } from "@/lib/fantasy-points"

export interface ComputeResult {
  updated: number
  total: number
  remapped: number
  autoAdded: number
  missed: string[]
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
  const pointsMap = calculateFantasyPoints(scorecard)
  if (pointsMap.size === 0) {
    return { updated: 0, total: 0, remapped: 0, autoAdded: 0, missed: [] }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const teamMap = playerTeamsFromScorecard(scorecard as any[])

  const { data: dbPlayers } = await supabaseAdmin
    .from("match_players")
    .select("cricketdata_player_id, name")
    .eq("match_id", matchId)

  const dbList = (dbPlayers || []).map((p: { cricketdata_player_id: string; name: string }) => ({
    id: p.cricketdata_player_id,
    name: p.name,
  }))
  const dbIds = new Set(dbList.map((p: { id: string }) => p.id))

  const now = new Date().toISOString()
  const directUpdates: Array<{ id: string; points: number }> = []
  const idRemaps: Array<{ oldId: string; newId: string; fantasyPoints: number }> = []
  const autoInsertPlayers: Array<{
    cricketdata_player_id: string; name: string; team: string; role: string; fantasy_points: number
  }> = []
  const autoInsertNames: string[] = []

  for (const [playerId, pts] of pointsMap.entries()) {
    const fantasyPoints = Math.round(pts.total * 10) / 10

    if (dbIds.has(playerId)) {
      directUpdates.push({ id: playerId, points: fantasyPoints })
    } else {
      const matched = dbList.find((p: { id: string; name: string }) => namesMatch(pts.name, p.name))
      if (matched) {
        idRemaps.push({ oldId: matched.id, newId: playerId, fantasyPoints })
      } else {
        // Truly unknown player (impact substitute not in original squad, e.g. Linde)
        // Auto-insert them so their points are tracked
        autoInsertPlayers.push({
          cricketdata_player_id: playerId,
          name: pts.name,
          team: teamMap.get(playerId) || "",
          role: inferRole(pts),
          fantasy_points: fantasyPoints,
        })
        autoInsertNames.push(pts.name)
      }
    }
  }

  // Parallel direct updates
  const directResults = await Promise.all(
    directUpdates.map(({ id, points }) =>
      supabaseAdmin
        .from("match_players")
        .update({ fantasy_points: points, last_updated: now })
        .eq("match_id", matchId)
        .eq("cricketdata_player_id", id)
    )
  )
  const updated = directResults.filter((r: { error: unknown }) => !r.error).length

  // Name-based remaps: correct stored ID and save points.
  // Deduplicate by oldId first — an all-rounder can appear twice in pointsMap
  // (once as batsman cb_ID_A, once as bowler cb_ID_B) but both name-match the
  // same DB row whose current ID is oldId.  The first remap changes the DB row's
  // cricketdata_player_id to cb_ID_A; the second then finds no row with oldId and
  // the bowling points are silently lost.  Fix: merge all remaps for the same
  // oldId into a single update with summed fantasy points.
  const mergedRemaps = new Map<string, { oldId: string; newId: string; fantasyPoints: number }>()
  for (const remap of idRemaps) {
    if (mergedRemaps.has(remap.oldId)) {
      mergedRemaps.get(remap.oldId)!.fantasyPoints += remap.fantasyPoints
    } else {
      mergedRemaps.set(remap.oldId, { ...remap })
    }
  }

  let remapped = 0
  for (const { oldId, newId, fantasyPoints } of mergedRemaps.values()) {
    const { error } = await supabaseAdmin
      .from("match_players")
      .update({ cricketdata_player_id: newId, fantasy_points: fantasyPoints, last_updated: now })
      .eq("match_id", matchId)
      .eq("cricketdata_player_id", oldId)
    if (!error) remapped++
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

  // Auto-insert truly unknown players (impact subs like Linde not in original squad)
  let autoAdded = 0
  const missed: string[] = []
  if (autoInsertPlayers.length > 0) {
    const { error } = await supabaseAdmin
      .from("match_players")
      .insert(
        autoInsertPlayers.map(p => ({
          match_id: matchId,
          cricketdata_player_id: p.cricketdata_player_id,
          name: p.name,
          team: p.team,
          role: p.role,
          is_playing: true,
          is_substitute: true,
          fantasy_points: p.fantasy_points,
          last_updated: now,
        }))
      )
    if (!error) {
      autoAdded = autoInsertPlayers.length
    } else {
      // Insert failed — report as missed
      missed.push(...autoInsertNames)
    }
  }

  return { updated: updated + remapped, total: pointsMap.size, remapped, autoAdded, missed }
}
