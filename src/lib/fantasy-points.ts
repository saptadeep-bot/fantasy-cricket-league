/**
 * IPL Fantasy Points Calculator
 * Uses raw scorecard data (match_scorecard endpoint) to compute points.
 *
 * 2026-04-28: extended to also produce a per-player line-item breakdown
 * (`components`) alongside the totals.  The breakdown is what gets shown to
 * users on the completed-match page so they can tally their score against
 * the actual scorecard ("Runs (45)", "Sixes (4 × 2)", "50+ bonus", "Wickets
 * (2 × 25)", etc).  Each component carries its section (batting/bowling/
 * fielding) so the UI can group them.
 */

export interface BreakdownComponent {
  section: "batting" | "bowling" | "fielding"
  label: string
  points: number
}

export interface PlayerFantasyPoints {
  id: string
  name: string
  batting: number
  bowling: number
  fielding: number
  total: number
  components: BreakdownComponent[]
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

interface BattingResult {
  total: number
  components: BreakdownComponent[]
}

function calcBattingDetail(
  r: number,
  b: number,
  fours: number,
  sixes: number,
  dismissal: string,
  useNewSrRules: boolean,
  isSpecialistBowler: boolean,
): BattingResult {
  const components: BreakdownComponent[] = []
  let total = 0
  const push = (label: string, points: number) => {
    if (points === 0) return
    components.push({ section: "batting", label, points })
    total += points
  }

  if (r > 0) push(`Runs (${r})`, r)
  if (fours > 0) push(`Fours (${fours} × 1)`, fours)
  if (sixes > 0) push(`Sixes (${sixes} × 2)`, sixes * 2)

  // Milestone bonuses — cumulative (a 100+ score gets all three: 5 + 10 + 25 = 40)
  if (r >= 30) push("30+ runs bonus", 5)
  if (r >= 50) push("50+ runs bonus", 10)
  if (r >= 100) push("100+ runs bonus", 25)

  // Duck penalty (dismissed on 0, faced at least 1 ball)
  const isOut = dismissal && !dismissal.toLowerCase().includes('not out') && dismissal.trim() !== ''
  if (r === 0 && isOut && b > 0) push("Duck penalty", -2)

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
    const srStr = sr.toFixed(1)
    if (useNewSrRules) {
      if      (sr >= 170) push(`Strike rate ${srStr} (≥170)`, 6)
      else if (sr >= 150) push(`Strike rate ${srStr} (150–170)`, 4)
      else if (sr >= 130) push(`Strike rate ${srStr} (130–150)`, 2)
      else if (sr < 50)   push(`Strike rate ${srStr} (<50)`, -6)
      else if (sr < 60)   push(`Strike rate ${srStr} (50–60)`, -4)
      else if (sr < 70)   push(`Strike rate ${srStr} (60–70)`, -2)
    } else {
      if      (sr >= 170) push(`Strike rate ${srStr} (≥170)`, 6)
      else if (sr >= 150) push(`Strike rate ${srStr} (150–170)`, 4)
      else if (sr >= 130) push(`Strike rate ${srStr} (130–150)`, 2)
      else if (sr < 40)   push(`Strike rate ${srStr} (<40)`, -6)
      else if (sr < 60)   push(`Strike rate ${srStr} (40–60)`, -4)
      else if (sr < 70)   push(`Strike rate ${srStr} (60–70)`, -2)
    }
  }

  return { total, components }
}

function actualOvers(o: number | string): number {
  // "3.4" = 3 overs + 4 balls (not 3.4 decimal overs)
  const num = typeof o === 'string' ? parseFloat(o) : (o ?? 0)
  const full = Math.floor(num)
  const balls = Math.round((num - full) * 10)
  return full + balls / 6
}

interface BowlingResult {
  total: number
  components: BreakdownComponent[]
}

function calcBowlingDetail(o: number | string, maidens: number, runs: number, wickets: number): BowlingResult {
  const components: BreakdownComponent[] = []
  let total = 0
  const push = (label: string, points: number) => {
    if (points === 0) return
    components.push({ section: "bowling", label, points })
    total += points
  }

  if (wickets > 0) push(`Wickets (${wickets} × 25)`, wickets * 25)

  // Wicket haul bonus (non-stacking tiers — 5W gives 30, 4W gives 20, 3W gives 10)
  if      (wickets >= 5) push("5-wicket haul bonus", 30)
  else if (wickets >= 4) push("4-wicket haul bonus", 20)
  else if (wickets >= 3) push("3-wicket haul bonus", 10)

  if (maidens > 0) push(`Maidens (${maidens} × 12)`, maidens * 12)

  // Economy rate bonus/penalty (min 2 overs bowled)
  const overs = actualOvers(o)
  if (overs >= 2) {
    const eco = runs / overs
    const ecoStr = eco.toFixed(2)
    if      (eco < 5)   push(`Economy ${ecoStr} (<5)`, 6)
    else if (eco < 6)   push(`Economy ${ecoStr} (5–6)`, 4)
    else if (eco <= 7)  push(`Economy ${ecoStr} (6–7)`, 2)
    else if (eco >= 12) push(`Economy ${ecoStr} (≥12)`, -6)
    else if (eco >= 11) push(`Economy ${ecoStr} (11–12)`, -4)
    else if (eco >= 10) push(`Economy ${ecoStr} (10–11)`, -2)
  }

  return { total, components }
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
  // Per-bowler running count of bowled/LBW dismissals.  We accumulate across
  // all batting events and emit a single aggregated component at the end so
  // the breakdown reads cleanly ("Bowled/LBW bonus (3 × 8)") instead of
  // three separate "+8" entries.
  const bowledLbwCountByBowler = new Map<string, number>()

  const getOrCreate = (id: string, name: string): PlayerFantasyPoints => {
    if (!playerMap.has(id)) {
      playerMap.set(id, { id, name, batting: 0, bowling: 0, fielding: 0, total: 0, components: [] })
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
      const result = calcBattingDetail(
        Number(entry.r ?? 0),
        Number(entry.b ?? 0),
        Number(entry['4s'] ?? 0),
        Number(entry['6s'] ?? 0),
        dismissalText,
        useNewSrRules,
        role === "BOWL",
      )
      const p = getOrCreate(id, name)
      p.batting += result.total
      p.total += result.total
      p.components.push(...result.components)

      // Bowled/LBW bonus: +8 pts to the bowler.  Aggregate the count and
      // emit one consolidated component after all innings are processed.
      const lower = dismissalText.toLowerCase().trim()
      const isBowled = lower.startsWith('b ') || lower === 'b'
      const isLBW = lower.startsWith('lbw')
      if (isBowled || isLBW) {
        const rawName = lower.replace(/^lbw\s+b\s+/, '').replace(/^b\s+/, '').trim()
        const bowler = bowlerByName.get(rawName)
        if (bowler) {
          const bp = getOrCreate(bowler.id, bowler.name)
          bp.bowling += 8
          bp.total += 8
          bowledLbwCountByBowler.set(
            bowler.id,
            (bowledLbwCountByBowler.get(bowler.id) ?? 0) + 1,
          )
        }
      }
    }

    // --- Bowling ---
    for (const entry of (inning.bowling || [])) {
      const id = extractId(entry, 'bowler')
      const name = extractName(entry, 'bowler')
      if (!id) continue

      const result = calcBowlingDetail(
        entry.o ?? 0,
        Number(entry.m ?? 0),
        Number(entry.r ?? 0),
        Number(entry.w ?? 0),
      )
      const p = getOrCreate(id, name)
      p.bowling += result.total
      p.total += result.total
      // Prefix the bowling stat-line so users can see what they did even when
      // they got 0 wickets / 0 special bonuses (otherwise no components emit
      // and the breakdown is silent).
      const overs = entry.o ?? 0
      const runsConceded = Number(entry.r ?? 0)
      const wkts = Number(entry.w ?? 0)
      // Insert the figures component at the head of the bowling section so
      // it reads as "0/22 in 4 overs → wickets (0×25), economy bonus, ..."
      p.components.push({
        section: "bowling",
        label: `Bowled ${overs}-${entry.m ?? 0}-${runsConceded}-${wkts}`,
        points: 0,
      })
      p.components.push(...result.components)
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

      const totalCatches = catches + cbDismiss
      const fieldingPts = totalCatches * 8 + stumpings * 12 + runouts * 12

      if (fieldingPts !== 0) {
        const p = getOrCreate(id, name)
        p.fielding += fieldingPts
        p.total += fieldingPts
        if (totalCatches > 0) {
          p.components.push({
            section: "fielding",
            label: `Catches (${totalCatches} × 8)`,
            points: totalCatches * 8,
          })
        }
        if (stumpings > 0) {
          p.components.push({
            section: "fielding",
            label: `Stumpings (${stumpings} × 12)`,
            points: stumpings * 12,
          })
        }
        if (runouts > 0) {
          p.components.push({
            section: "fielding",
            label: `Run outs (${runouts} × 12)`,
            points: runouts * 12,
          })
        }
      }
    }
  }

  // Emit consolidated bowled/LBW bonus components per bowler.
  for (const [bowlerId, count] of bowledLbwCountByBowler.entries()) {
    const bp = playerMap.get(bowlerId)
    if (bp && count > 0) {
      bp.components.push({
        section: "bowling",
        label: `Bowled / LBW dismissals (${count} × 8)`,
        points: count * 8,
      })
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
  // name into a single entry by summing their points AND their components.
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
      primary.components.push(...pts.components)
      toDelete.push(id)
    } else {
      seenNames.set(key, id)
    }
  }
  for (const id of toDelete) playerMap.delete(id)

  return playerMap
}
