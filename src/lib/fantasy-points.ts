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

function calcBattingPoints(r: number, b: number, fours: number, sixes: number, dismissal: string): number {
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

  // Strike rate bonus/penalty (min 10 balls faced)
  if (b >= 10) {
    const sr = (r / b) * 100
    if      (sr >= 170) pts += 6
    else if (sr >= 150) pts += 4
    else if (sr >= 130) pts += 2
    else if (sr < 40)   pts -= 6
    else if (sr < 60)   pts -= 4
    else if (sr < 70)   pts -= 2
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
export function calculateFantasyPoints(scorecard: any[]): Map<string, PlayerFantasyPoints> {
  const playerMap = new Map<string, PlayerFantasyPoints>()

  const getOrCreate = (id: string, name: string): PlayerFantasyPoints => {
    if (!playerMap.has(id)) {
      playerMap.set(id, { id, name, batting: 0, bowling: 0, fielding: 0, total: 0 })
    }
    return playerMap.get(id)!
  }

  for (const inning of scorecard) {
    // --- Batting ---
    for (const entry of (inning.batting || [])) {
      const id = extractId(entry, 'batsman')
      const name = extractName(entry, 'batsman')
      if (!id) continue

      const dismissalText = (entry['dismissal-text'] ?? entry.dismissal ?? '') as string
      const pts = calcBattingPoints(
        Number(entry.r ?? 0),
        Number(entry.b ?? 0),
        Number(entry['4s'] ?? 0),
        Number(entry['6s'] ?? 0),
        dismissalText
      )
      const p = getOrCreate(id, name)
      p.batting += pts
      p.total += pts
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

  return playerMap
}
