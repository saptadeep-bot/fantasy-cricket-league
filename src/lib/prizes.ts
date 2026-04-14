/**
 * Prize pool rules
 *
 * 1 player  → full refund
 * 2 players → winner takes all (100%)
 * 3–6 players → 1st: 65%, 2nd: 35%
 * 7+ players  → 1st: 50%, 2nd: 30%, 3rd: 20%
 */

export function getEntryFee(matchType: string): number {
  const type = (matchType || "league").toLowerCase()
  if (type === "final") return 500
  if (
    type === "eliminator" ||
    type === "qualifier" ||
    type.includes("qualifier") ||
    type.includes("eliminator")
  )
    return 350
  return 250 // league
}

interface RankedScore {
  user_id: string
  rank: number
  raw_points: number
  final_points: number
}

export interface PrizeResult {
  user_id: string
  rank: number
  raw_points: number
  final_points: number
  prize_won: number
}

/**
 * Given a sorted (desc by final_points) list of ranked scores and the total pool,
 * returns the prize each player wins.
 */
export function calcPrizes(
  ranked: RankedScore[],
  totalPool: number,
  entryFee: number
): PrizeResult[] {
  const n = ranked.length

  if (n === 0) return []

  // Helper: players sharing a given rank position
  const atRank = (pos: number) => ranked.filter(r => r.rank === pos)

  // ── 1 player: full refund ────────────────────────────────────────────────
  if (n === 1) {
    return [{ ...ranked[0], prize_won: entryFee }]
  }

  // ── 2 players: winner takes all ──────────────────────────────────────────
  if (n === 2) {
    const first = atRank(1)
    const prizePerFirst = Math.round(totalPool / first.length)
    return ranked.map(r => ({
      ...r,
      prize_won: first.find(f => f.user_id === r.user_id) ? prizePerFirst : 0,
    }))
  }

  // ── 3–6 players: 65 / 35 (two winners) ──────────────────────────────────
  if (n <= 6) {
    const first = atRank(1)
    const second = atRank(2)

    // Everyone tied at rank 1 → split pool equally
    if (second.length === 0) {
      const prizeEach = Math.round(totalPool / first.length)
      return ranked.map(r => ({
        ...r,
        prize_won: first.find(f => f.user_id === r.user_id) ? prizeEach : 0,
      }))
    }

    const firstPool = Math.round(totalPool * 0.65)
    const secondPool = totalPool - firstPool
    const prizePerFirst = Math.round(firstPool / first.length)
    const prizePerSecond = Math.round(secondPool / second.length)

    return ranked.map(r => {
      if (first.find(f => f.user_id === r.user_id)) return { ...r, prize_won: prizePerFirst }
      if (second.find(s => s.user_id === r.user_id)) return { ...r, prize_won: prizePerSecond }
      return { ...r, prize_won: 0 }
    })
  }

  // ── 7+ players: 50 / 30 / 20 (three winners) ────────────────────────────
  const first = atRank(1)
  const second = atRank(2)
  const third = atRank(3)

  // All tied at 1st → split equally
  if (second.length === 0) {
    const prizeEach = Math.round(totalPool / first.length)
    return ranked.map(r => ({
      ...r,
      prize_won: first.find(f => f.user_id === r.user_id) ? prizeEach : 0,
    }))
  }

  // 1st and 2nd only (everyone else tied for 2nd) → 50/50
  if (third.length === 0) {
    const firstPool = Math.round(totalPool * 0.5)
    const secondPool = totalPool - firstPool
    const prizePerFirst = Math.round(firstPool / first.length)
    const prizePerSecond = Math.round(secondPool / second.length)
    return ranked.map(r => {
      if (first.find(f => f.user_id === r.user_id)) return { ...r, prize_won: prizePerFirst }
      if (second.find(s => s.user_id === r.user_id)) return { ...r, prize_won: prizePerSecond }
      return { ...r, prize_won: 0 }
    })
  }

  const firstPool = Math.round(totalPool * 0.5)
  const secondPool = Math.round(totalPool * 0.3)
  const thirdPool = totalPool - firstPool - secondPool // avoids rounding drift
  const prizePerFirst = Math.round(firstPool / first.length)
  const prizePerSecond = Math.round(secondPool / second.length)
  const prizePerThird = Math.round(thirdPool / third.length)

  return ranked.map(r => {
    if (first.find(f => f.user_id === r.user_id)) return { ...r, prize_won: prizePerFirst }
    if (second.find(s => s.user_id === r.user_id)) return { ...r, prize_won: prizePerSecond }
    if (third.find(t => t.user_id === r.user_id)) return { ...r, prize_won: prizePerThird }
    return { ...r, prize_won: 0 }
  })
}
