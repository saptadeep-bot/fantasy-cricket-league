/**
 * IPL Fantasy Points Calculator
 * Uses raw scorecard data (match_scorecard endpoint) to compute points.
 */

export interface PlayerFantasyPoints {
  id: string
  name: string
  batting: number
  bowling: number
  fielding: number
  total: number
}

export type PlayerRole = "BAT" | "BOWL" | "ALL" | "WK"

export interface CalcOptions {
  /**
   * Match's scheduled_at.  Drives strike-rate rule selection: matches on or
   * after `SR_RULES_NEW_FROM` use the 2026-04-28 ruleset (different floor
   * thresholds and specialist-bowler exemption); earlier matches use the
   * legacy ruleset so re-finalising an old match doesn't retroactively
   * change its scores.  Default: today (i.e. new rules).
   */
  matchDate?: string | Date | null
  /**
   * Look up a player's role by their scorecard ID + name.  The role is used
   * to skip the strike-rate adjustment for specialist bowlers (BOWL only —
   * all-rounders/ALL still get judged on SR because they bat regularly).
   * If undefined or returns undefined for a player, SR is applied as if
   * they were a batter (safe default — known bowlers in the squad are
   * caught by the lookup, unknown auto-inserts get treated like batters
   * until the next squad fetch corrects their role).
   */
  getRole?: (id: string, name: string) => PlayerRole | undefined
}

// 2026-04-28: switched to the new SR ruleset.  Matches scheduled before
// this date keep the legacy thresholds so re-finalising an old match
// doesn't change its historical scores.
export const SR_RULES_NEW_FROM = new Date("2026-04-28T00:00:00Z")

function shouldUseNewSrRules(matchDate?: string | Date | null): boolean {
  if (!matchDate) return true   // safe default — current/future matches
  const d = typeof matchDate === "string" ? new Date(matchDate) : matchDate
  if (isNaN(d.getTime())) return true
  return d.getTime() >= SR_RULES_NEW_FROM.getTime()
}

function calcBattingPoints(
  r: number,
  b: number,
  fours: number,
  sixes: number,
  dismissal: string,
  useNewSrRules: boolean,
  isSpecialistBowler: boolean,
): number {
  let pts = 0

  pts += r           // 1 pt per run
  pts += fours       // 1 pt per four
  pts += sixes * 2   // 2 pts per six

  // Milestone bonuses
  if (r >= 100) pts += 25
  if (r >= 50)  pts += 10
  if (r >= 30)  pts += 5

  // Duck penalty (dismissed on 0, faced at least 1 ball)
  const isOut = dismissal && !dismissal.toLowerCase().includes('not out') && dismissal.trim() !== ''
  if (r === 0 && isOut && b > 0) pts -= 2

  // Strike rate bonus/penalty (min 10 balls faced).
  //
  // 2026-04-28 ruleset:
  //   - Specialist bowlers (role === "BOWL") are exempt entirely.  They
  //     aren't expected to bat at a healthy SR.  All-rounders (ALL) are
  //     NOT exempt — they bat regularly.
  //   - Bonus thresholds unchanged: ≥170 → +6, 150–170 → +4, 130–150 → +2.
  //   - Penalty thresholds shifted: 60–70 → -2, 50–60 → -4, <50 → -6
  //     (was <40 → -6, 40–60 → -4, 60–70 → -2).
  //
  // Legacy ruleset (matches before 2026-04-28) is preserved verbatim so
  // re-finalise on historical matches doesn't move scores.
  if (b >= 10 && !(useNewSrRules && isSpecialistBowler)) {
    const sr = (r / b) * 100
    if (useNewSrRules) {
      if      (sr >= 170) pts += 6
      else if (sr >= 150) pts += 4
      else if (sr >= 130) pts += 2
      else if (sr < 50)   pts -= 6
      else if (sr < 60)   pts -= 4
      else if (sr < 70)   pts -= 2
    } else {
      if      (sr >= 170) pts += 6
      else if (sr >= 150) pts += 4
      else if (sr >= 130) pts += 2
      else if (sr < 40)   pts -= 6
      else if (sr < 60)   pts -= 4
      else if (sr < 70)   pts -= 2
    }
  }

  return pts
}

function actualOvers(o: number | string): number {
  // "3.4" = 3 overs + 4 balls (not 3.4 decimal overs)
  const num = typeof o === 'string' ? parseFloat(o) : (o ?? 0)
  const full = Math.floor(num)
  const balls = Math.round((num - full) * 10)
  return full + balls / 6
}

function calcBowlingPoints(o: number | string, maidens: number, runs: number, wickets: number): number {
  let pts = 0

  pts += wickets * 25

  // Wicket haul bonus (non-stacking tiers)
  if      (wickets >= 5) pts += 30
  else if (wickets >= 4) pts += 20
  else if (wickets >= 3) pts += 10

  // Maiden bonus
  pts += maidens * 12

  // Economy rate bonus/penalty (min 2 overs bowled)
  const overs = actualOvers(o)
  if (overs >= 2) {
    const eco = runs / overs
    if      (eco < 5)   pts += 6
    else if (eco < 6)   pts += 4
    else if (eco <= 7)  pts += 2
    else if (eco >= 12) pts -= 6
    else if (eco >= 11) pts -= 4
    else if (eco >= 10) pts -= 2
  }

  return pts
}

// Handles both flat {id, name, ...} and nested {batsman: {id, name}, ...} structures
function extractId(entry: Record<string, unknown>, nestedKey: string): string {
  if (typeof entry.id === 'string') return entry.id
  const nested = entry[nestedKey] as Record<string, unknown> | undefined
  return (nested?.id as string) ?? ''
}

function extractName(entry: Record<string, unknown>, nestedKey: string): string {
  if (typeof entry.name === 'string') return entry.name
  const nested = entry[nestedKey] as Record<string, unknown> | undefined
  return (nested?.name as string) ?? ''
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function calculateFantasyPoints(scorecard: any[], options: CalcOptions = {}): Map<string, PlayerFantasyPoints> {
  const playerMap = new Map<string, PlayerFantasyPoints>()
  const useNewSrRules = shouldUseNewSrRules(options.matchDate)
  const getRole = options.getRole ?? (() => undefined)

  const getOrCreate = (id: string, name: string): PlayerFantasyPoints => {
    if (!playerMap.has(id)) {
      playerMap.set(id, { id, name, batting: 0, bowling: 0, fielding: 0, total: 0 })
    }
    return playerMap.get(id)!
  }

  for (const inning of scorecard) {
    // Build bowler name → {id, name} map for bowled/LBW bonus lookup
    const bowlerByName = new Map<string, { id: string; name: string }>()
    for (const entry of (inning.bowling || [])) {
      const id = extractId(entry, 'bowler')
      const name = extractName(entry, 'bowler')
      if (id && name) bowlerByName.set(name.toLowerCase(), { id, name })
    }

    // --- Batting ---
    for (const entry of (inning.batting || [])) {
      const id = extractId(entry, 'batsman')
      const name = extractName(entry, 'batsman')
      if (!id) continue

      const dismissalText = (entry['dismissal-text'] ?? entry.dismissal ?? '') as string
      const role = getRole(id, name)
      const pts = calcBattingPoints(
        Number(entry.r ?? 0),
        Number(entry.b ?? 0),
        Number(entry['4s'] ?? 0),
        Number(entry['6s'] ?? 0),
        dismissalText,
        useNewSrRules,
        role === "BOWL",
      )
      const p = getOrCreate(id, name)
      p.batting += pts
      p.total += pts

      // Bowled/LBW bonus: +8 pts to the bowler
      const lower = dismissalText.toLowerCase().trim()
      const isBowled = lower.startsWith('b ') || lower === 'b'
      const isLBW = lower.startsWith('lbw')
      if (isBowled || isLBW) {
        // Extract bowler name: "b Name" → "name", "lbw b Name" → "name"
        const rawName = lower.replace(/^lbw\s+b\s+/, '').replace(/^b\s+/, '').trim()
        const bowler = bowlerByName.get(rawName)
        if (bowler) {
          const bp = getOrCreate(bowler.id, bowler.name)
          bp.bowling += 8
          bp.total += 8
        }
      }
    }

    // --- Bowling ---
    for (const entry of (inning.bowling || [])) {
      const id = extractId(entry, 'bowler')
      const name = extractName(entry, 'bowler')
      if (!id) continue

      const pts = calcBowlingPoints(
        entry.o ?? 0,
        Number(entry.m ?? 0),
        Number(entry.r ?? 0),
        Number(entry.w ?? 0)
      )
      const p = getOrCreate(id, name)
      p.bowling += pts
      p.total += pts
    }

    // --- Fielding (from catching array — more reliable than parsing dismissal strings) ---
    for (const entry of (inning.catching || [])) {
      const catcher = entry.catcher as Record<string, unknown> | undefined
      const id = (catcher?.id ?? entry.id) as string
      const name = (catcher?.name ?? entry.name) as string
      if (!id) continue

      const catches   = Number(entry.catch ?? 0)
      const stumpings = Number(entry.stumped ?? 0)
      const runouts   = Number(entry.runout ?? 0)
      const cbDismiss = Number(entry.cb ?? 0) // caught & bowled (bowler gets catch credit too)

      const fieldingPts = (catches + cbDismiss) * 8 + stumpings * 12 + runouts * 12

      if (fieldingPts !== 0) {
        const p = getOrCreate(id, name)
        p.fielding += fieldingPts
        p.total += fieldingPts
      }
    }
  }

  // ── Name-based deduplication ──────────────────────────────────────────────
  // When the scorecard source (e.g. Cricbuzz) assigns different IDs to the
  // same player in the batting table vs the bowling table, they land in
  // playerMap as two separate entries with different IDs but the same name.
  // If we don't merge them here, computeAndSave will try to remap both IDs to
  // the same DB row — the second remap finds no row (first one already
  // changed the stored ID) and the bowling / batting points are silently lost.
  // Fix: after processing all innings, collapse entries that share the same
  // name into a single entry by summing their points.
  const seenNames = new Map<string, string>() // normalised name → primary ID
  const toDelete: string[] = []
  for (const [id, pts] of playerMap.entries()) {
    const key = pts.name.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()
    if (seenNames.has(key)) {
      const primaryId = seenNames.get(key)!
      const primary = playerMap.get(primaryId)!
      primary.batting  += pts.batting
      primary.bowling  += pts.bowling
      primary.fielding += pts.fielding
      primary.total    += pts.total
      toDelete.push(id)
    } else {
      seenNames.set(key, id)
    }
  }
  for (const id of toDelete) playerMap.delete(id)

  return playerMap
}
