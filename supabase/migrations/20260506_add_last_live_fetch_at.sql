-- Add last_live_fetch_at column to matches for server-side polling cache.
--
-- WHY: client polling was at 60s to stay within RapidAPI quota.  Faster
-- client polling would multiply external API calls 1:1 (N concurrent users
-- → N external fetches per cycle).  By gating the external fetch on a
-- match-level timestamp, we can let the client poll every 30s while the
-- SERVER only hits external APIs once per ~25-30s no matter how many
-- viewers are watching.
--
-- IMPORTANT: this is a SEPARATE timestamp from match_players.last_updated.
-- The 2026-04-20 frozen-scores bug was caused by re-using last_updated as
-- a cache key — admin POSTs kept it warm, making auto-poll GETs always
-- skip the external fetch.  This dedicated column avoids that.  Admin POST
-- bypasses the cache entirely.
--
-- Run this once against the prod Supabase project (SQL editor → paste → run).
-- Idempotent: the `if not exists` guard means re-running is safe.

alter table matches
  add column if not exists last_live_fetch_at timestamptz;
