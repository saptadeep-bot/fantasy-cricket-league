-- Add EntitySport match_id cache column to matches.
--
-- WHY: every live poll and every squad fetch used to re-run the 5-URL
-- EntitySport listing aggregation to map our stored team names → EntitySport's
-- internal match_id.  Each of those URL calls counts against the RapidAPI
-- quota.  For a 4-hour match polling every 60s we were burning ~1,200 listing
-- calls just to keep discovering the same match_id over and over.
--
-- Fix: cache the resolved EntitySport match_id on the matches row the first
-- time we resolve it.  Subsequent polls skip the listing aggregation entirely
-- and go straight to /matches/{id}/info.  Expected quota savings: ~80%.
--
-- The cricbuzz_match_id column was added in the original schema but was never
-- wired up — as of 2026-04-23 we're now filling it alongside
-- entitysport_match_id for the same reason.  No migration needed for that
-- column; it already exists.
--
-- Run this once against the prod Supabase project (SQL editor → paste → run).
-- Idempotent: the `if not exists` guard means re-running is safe.

alter table matches
  add column if not exists entitysport_match_id text;

-- Useful for debugging: show matches that have / haven't been resolved yet.
-- (This is an index for the admin, not a performance need — table is small.)
create index if not exists idx_matches_entitysport_match_id
  on matches (entitysport_match_id)
  where entitysport_match_id is not null;
