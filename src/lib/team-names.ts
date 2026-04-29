// Shared team-name matching utilities.
//
// Originally lived inside `src/app/api/admin/matches/[id]/fetch-squad/route.ts`
// where it caught cricapi's pre-toss "wrong team" responses (Lahore Qalandars
// returned for an MI vs SRH fixture, 2026-04-28).  Lifted here on 2026-04-28
// after the same root cause showed up at LIVE SCORING time too — EntitySport
// was returning scorecard data from a completely different fixture (PAK vs NZ
// players' points landing in MI vs SRH's match_players table).
//
// The fix is to canonicalise EVERY team name returned by an external API
// against the match's configured team1/team2 — at squad fetch, at live poll,
// at finalize.  This file is the single source of truth for that matching.

// Curated alias map for IPL teams.  Falls back to generic acronym/substring
// matching for non-IPL fixtures (warm-ups, rare tournaments) and to handle
// short-codes EntitySport sometimes returns ("RCB", "LSG", etc.).
const TEAM_ALIASES: Record<string, string[]> = {
  "royal challengers bengaluru": ["rcb", "royal challengers bangalore", "bengaluru", "bangalore"],
  "royal challengers bangalore": ["rcb", "royal challengers bengaluru", "bengaluru", "bangalore"],
  "chennai super kings": ["csk", "chennai"],
  "mumbai indians": ["mi", "mumbai"],
  "kolkata knight riders": ["kkr", "kolkata"],
  "sunrisers hyderabad": ["srh", "sunrisers", "hyderabad"],
  "delhi capitals": ["dc", "delhi"],
  "punjab kings": ["pbks", "punjab", "kings xi punjab", "kxip"],
  "rajasthan royals": ["rr", "rajasthan"],
  "lucknow super giants": ["lsg", "lucknow"],
  "gujarat titans": ["gt", "gujarat"],
}

export function normaliseTeamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim()
}

function acronymOf(name: string): string {
  const parts = normaliseTeamName(name).split(" ").filter(Boolean)
  if (parts.length < 2) return ""
  return parts.map(p => p[0]).join("")
}

/**
 * Returns true if `a` and `b` plausibly refer to the same team.  Uses curated
 * IPL alias map first, then generic acronym matching, then substring fallback.
 *
 * IMPORTANT: don't loosen this without thinking — the live-scoring bug on
 * 2026-04-28 happened because `fetchEntitySportScorecardDetailed` had no
 * validation at all.  False positives here mean PAK/NZ players' points
 * leak into IPL matches.
 */
export function sameTeam(a: string, b: string): boolean {
  const na = normaliseTeamName(a), nb = normaliseTeamName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Curated alias lookup first.
  const aliasA = TEAM_ALIASES[na] ?? []
  if (aliasA.includes(nb)) return true
  const aliasB = TEAM_ALIASES[nb] ?? []
  if (aliasB.includes(na)) return true
  if (aliasA.some(x => aliasB.includes(x))) return true
  // Generic acronym match: "lsg" vs "lucknow super giants"
  if (acronymOf(na) === nb || acronymOf(nb) === na) return true
  // Substring fallback (must be a meaningful overlap — single word in common
  // is fine, e.g. "Mumbai Indians" vs "Mumbai")
  return na.includes(nb) || nb.includes(na)
}

/**
 * Canonicalise an API-returned team name against the match's configured
 * team1/team2.  Returns the canonical DB string (matchTeam1 or matchTeam2)
 * on match, or null if the API returned a rogue team that doesn't belong
 * to this fixture.
 *
 * Use this everywhere external scorecard/squad data enters the system —
 * fetch-squad, live scoring, finalize.
 */
export function canonicalTeam(
  apiTeamName: string,
  matchTeam1: string,
  matchTeam2: string,
): string | null {
  if (!apiTeamName) return null
  if (sameTeam(apiTeamName, matchTeam1)) return matchTeam1
  if (sameTeam(apiTeamName, matchTeam2)) return matchTeam2
  return null
}

/**
 * Strip the trailing "Inning N" / "Innings N" from EntitySport's innings
 * label so we can canonicalise just the team part.
 *
 * Example: "Mumbai Indians Inning 1" → "Mumbai Indians"
 *          "New Zealand Innings 2"   → "New Zealand"
 */
export function teamFromInningLabel(inningLabel: string): string {
  return (inningLabel ?? "").replace(/\s+(Inning|Innings)\s+\d+$/i, "").trim()
}
