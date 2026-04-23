-- Schema safety migration — run once against prod Supabase (SQL editor → paste → run).
-- Idempotent: all `if not exists` guards mean re-running is safe.
--
-- Two independent fixes bundled here so there's exactly one thing to run:
--
-- 1) matches.entitysport_match_id — cache of the resolved EntitySport match_id.
--    Every live poll and every squad fetch used to re-run the 5-URL EntitySport
--    listing aggregation to map stored team names → EntitySport's internal
--    match_id.  Each call counts against the RapidAPI quota.  For a 4-hour
--    match polling every 60s that's ~1,200 listing calls per match just to
--    keep rediscovering the same ID.  Cache it on first resolve and subsequent
--    polls skip the listing aggregation entirely (~80% quota savings).
--
--    The cricbuzz_match_id column already existed in the original schema; as
--    of 2026-04-23 we fill it alongside entitysport_match_id for the same
--    reason.  No migration needed for cricbuzz_match_id.
--
-- 2) match_players.is_substitute — flag marking impact subs so the UI and
--    lock flow can distinguish them from the announced XI.  Has been used in
--    code (lock route, fetch-squad, add-player, live-scoring auto-insert)
--    for weeks but was never added to schema.sql, so any Supabase project
--    bootstrapped from the canonical schema would 500 on the write path.
--    Add defensively here.

alter table matches
  add column if not exists entitysport_match_id text;

create index if not exists idx_matches_entitysport_match_id
  on matches (entitysport_match_id)
  where entitysport_match_id is not null;

alter table match_players
  add column if not exists is_substitute boolean default false;
