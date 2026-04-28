-- Add points_breakdown column to match_players for the post-match
-- score-breakdown feature.
--
-- WHY: users want to tally their fantasy score against the actual scorecard
-- after a match ends.  We compute the breakdown inside `calculateFantasyPoints`
-- — runs, fours, sixes, milestone bonuses, SR adjustment, wickets, hauls,
-- maidens, economy, fielding events, bowled/LBW credits — but until now we
-- only persisted the total.  This column stores the per-player line-item
-- breakdown so the completed-match page can render it on demand.
--
-- Shape: jsonb array of `{ section, label, points }` objects, e.g.
--   [
--     { "section": "batting", "label": "Runs (45)", "points": 45 },
--     { "section": "batting", "label": "Sixes (4 × 2)", "points": 8 },
--     { "section": "batting", "label": "30+ runs bonus", "points": 5 },
--     { "section": "batting", "label": "Strike rate 140.6 (130–150)", "points": 2 },
--     { "section": "bowling", "label": "Wickets (2 × 25)", "points": 50 },
--     { "section": "bowling", "label": "Bowled / LBW dismissals (1 × 8)", "points": 8 },
--     { "section": "fielding", "label": "Catches (1 × 8)", "points": 8 }
--   ]
--
-- Existing rows have NULL — we don't backfill historical matches because the
-- raw scorecards aren't always reachable retroactively.  The UI handles NULL
-- gracefully by showing "Breakdown not available for older matches."
--
-- Run this once against the prod Supabase project (SQL editor → paste → run).
-- Idempotent: the `if not exists` guard means re-running is safe.

alter table match_players
  add column if not exists points_breakdown jsonb;
