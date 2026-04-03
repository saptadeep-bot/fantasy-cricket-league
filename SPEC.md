# Fantasy Cricket League — IPL 2026
## Complete Product Specification

---

## 1. Overview

A private, per-match fantasy cricket web application for a closed group of **5 friends** playing across the full **IPL 2026** season (~70 league + 4 playoff matches). Each friend picks a team of 11 before every match; fantasy points are sourced live from **cricketdata.org (CricAPI)**, with match schedule and playing XI fetched from **Cricbuzz (via RapidAPI)**. A shared prize pool of **₹12,500** (5 × ₹2,500) is distributed match-by-match, with larger payouts for playoff matches. A season-end bonus uses any accumulated reserve.

---

## 2. Users & Roles

| Role | Count | Description |
|------|-------|-------------|
| Admin | 1 | One designated friend. Creates all accounts, manages matches, can edit/cancel matches, views payout ledger, posts match result announcements. |
| Player | 4 | Regular users. Pick teams, view scores, view leaderboard and ledger. |

**Authentication:** Google OAuth (via NextAuth.js). Admin pre-creates all 5 accounts before the season. No self-registration. Only the 5 pre-registered Google accounts can log in.

---

## 3. Season Structure

- **League matches:** ~70 matches (10 teams × 14 games each ÷ 2)
- **Playoff matches:** 4
  - Qualifier 1 (Q1)
  - Eliminator
  - Qualifier 2 (Q2)
  - Final
- **Total:** ~74 matches

> Note: Exact match count may vary. Admin can add/cancel matches as the official IPL schedule is published.

---

## 4. Prize Pool & Payouts

### 4.1 Total Pool
**₹12,500** (5 players × ₹2,500 each). The Cricbuzz API subscription cost (₹1,200) is a **separate expense** split equally outside the app.

### 4.2 Fixed Prize Per Match Type

| Match Type | Prize Pool |
|------------|-----------|
| League match | ₹140 |
| Qualifier 1 | ₹500 |
| Qualifier 2 | ₹500 |
| Eliminator | ₹500 |
| Final | ₹1,200 |

> Math check: 70 × ₹140 + ₹500 + ₹500 + ₹500 + ₹1,200 = ₹9,800 + ₹2,700 = **₹12,500** ✓

### 4.3 Winner Split (per match)
- **1st place:** 65% of match prize pool
- **2nd place:** 35% of match prize pool

Example (league match, 5 participants):
- 1st: ₹91, 2nd: ₹49

### 4.4 Participation Scaling
Prize pool scales with the number of players who submitted a valid team:

| Participants | Winners | Prize Pool | Unspent → |
|---|---|---|---|
| 5 | 2 (1st + 2nd) | 100% of base prize | — |
| 4 | 2 (1st + 2nd) | 80% of base prize | 20% → season reserve |
| 3 | 1 (1st only) | 60% of base prize | 40% → season reserve |
| < 3 | None | 0% — no payout | 100% → next match rollover |

- When fewer than 5 participate: unspent fraction goes to the **season-end reserve**.
- When fewer than 3 participate: full prize **rolls over** to the next match (adds to that match's prize pool). Multiple rollovers stack.

### 4.5 Abandoned / Washed-Out Matches
If a match is officially abandoned, cancelled, or has no result (rain, etc.):
- No teams count, no scores recorded.
- Full match prize **rolls over** to the next scheduled match.
- Admin marks the match as "Abandoned" in the admin panel.

### 4.6 Tie-Breaking
If two or more players have identical total fantasy points for a match:
- They **split the prize equally** for that position.
- Example: Two players tie for 1st → each gets 50% of (65% of prize pool).
- If two players tie for 2nd → each gets 50% of (35% of prize pool).

### 4.7 Season-End Reserve Prize
Any money accumulated in the reserve (from low-participation matches) is awarded at season end:
- **1st overall season points:** 65% of reserve
- **2nd overall season points:** 35% of reserve
- Overall season points = cumulative fantasy points across all matches the player participated in.
- Admin manually confirms and distributes reserve at season end.

---

## 5. Team Selection

### 5.1 Format
- Pick **11 players** from the two playing XIs (populated after toss)
- **No budget cap** — pick any 11 players freely
- **Role constraints only** (minimum per role):
  - Minimum 1 Wicket-Keeper (WK)
  - Minimum 3 Batters (BAT)
  - Minimum 3 Bowlers (BOWL)
  - Minimum 1 All-Rounder (ALL)
  - Maximum 7 players from one team
- **Captain:** 2× point multiplier
- **Vice-Captain:** 1.5× point multiplier

### 5.2 Team Lock
- Teams lock **after toss announcement** (~15–20 minutes before match starts)
- The toss + playing XI are confirmed at this point
- Players can **edit their team freely** up until lock time
- Only **1 team per player per match**

### 5.3 Captain / VC Rules
- If a selected Captain **did not play** (despite being in the announced XI), their score is **0 points** — no auto-promotion of VC.
- Same rule applies to VC.
- Players are responsible for selecting a captain who actually played.

### 5.4 Duplicate Teams
- No restriction on two players submitting identical teams.
- If identical teams result in a tie, tie-breaking rules apply (prize split).

### 5.5 Missed Submission
- If a player does not submit a team before lock: they receive **0 points** for that match.
- They are excluded from that match's prize pool calculation (participation count decreases).

---

## 6. Scoring

### 6.1 Source
Fantasy points are fetched **directly from Cricbuzz API** (RapidAPI). No custom scoring rules. Whatever Cricbuzz awards a player in their fantasy scoring is used as-is.

Captain and VC multipliers (2× and 1.5×) are applied **by this app** after fetching raw player points.

### 6.2 Live Scoring
- During a match, the app **polls the Cricbuzz API every 2–3 minutes** to fetch updated player fantasy points.
- Live scores are visible to all users while the match is in progress.
- Once match status = "completed", the app fetches the final scorecard and locks scores.

### 6.3 Finalization
- Scores are auto-finalized when Cricbuzz API marks the match as complete.
- Admin can **manually trigger a score re-fetch** if API data appears incorrect.
- Admin cannot override individual player scores; only re-fetch from Cricbuzz.

---

## 7. Admin Features

### 7.1 Match Management
- View all scheduled matches (auto-populated from Cricbuzz API)
- Mark a match as: Upcoming / Live / Completed / Abandoned
- Edit match details (date, time, teams) if Cricbuzz data is wrong
- Manually trigger score fetch for any match

### 7.2 Payout Ledger
- Running **net balance per player**: total prize money won − total contributed to pool
- Per-match transaction log: who won, how much, match name, date
- Season reserve balance tracker
- Admin can mark a payout as "settled" (money transferred via UPI outside the app)
- Ledger is **visible to all players** (transparency)

### 7.3 Match Result Announcement
- Admin can post a short result summary visible on the home screen for all players after each match.

---

## 8. Leaderboard

Full season-long leaderboard, updated after each match:

| Column | Description |
|--------|-------------|
| Rank | Current season rank by cumulative points |
| Player | Friend's name |
| Total Points | Sum of fantasy points across all matches played |
| Matches Played | Matches where team was submitted |
| 1st Place Wins | Number of times finished 1st in a match |
| 2nd Place Wins | Number of times finished 2nd in a match |
| Prize Won (₹) | Total prize money earned to date |

---

## 9. User Interface

### 9.1 Home Screen (default landing after login)
1. **Upcoming Match Card** (prominent, top section)
   - Match details: teams, date/time, venue
   - Status: "Pick your team", "Team submitted ✓", "Locked", "Live", "Completed"
   - CTA button: "Pick Team" / "Edit Team" / "View Results"
2. **Last Match Result** (below match card)
   - Points scored by each player, winner(s), payout amounts
3. **Season Leaderboard** (below results, compact top-5 view)
   - Link to full leaderboard page

### 9.2 Team Selection Screen
- Player list from playing XIs (fetched from Cricbuzz after toss)
- Filter by role (WK / BAT / ALL / BOWL) and by team
- Players selected counter (e.g. "8/11 selected")
- Role constraint indicators (e.g. "WK: 1/1 ✓", "BAT: 2/3 ✗")
- Captain / VC selector (tap player to assign)
- Submit / Edit button (available until lock)
- Warning if fewer than 11 selected or role constraints not met

### 9.3 Match History Page
- List of all past matches with: date, teams, prize pool, your score, rank, payout
- Click into any match for full scorecard and all 5 players' teams + points

### 9.4 Leaderboard Page
- Full leaderboard table with all columns (see Section 8)

### 9.5 Payout Ledger Page
- Visible to all players
- Net balance table: who is up/down
- Per-match log with settle status
- Season reserve balance

### 9.6 Admin Panel
- Accessible only to admin account
- Tabs: Match Management | Score Sync | Payout Ledger | Announcements

---

## 10. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), React, Tailwind CSS |
| Backend | Next.js API Routes (serverless) |
| Database | Supabase (PostgreSQL, free tier — sufficient for 5 users) |
| Auth | NextAuth.js with Google OAuth provider |
| External API (schedule + playing XI) | Cricbuzz via RapidAPI |
| External API (fantasy points + scorecard) | cricketdata.org (CricAPI) |
| Hosting | Vercel (free hobby tier, sufficient for 5 users) |
| Scheduling | Vercel Cron Jobs (for auto-polling Cricbuzz during live matches) |

### 10.1 Environment Variables
```
NEXTAUTH_SECRET=
NEXTAUTH_URL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
CRICBUZZ_API_KEY=           # RapidAPI key — for schedule + playing XI
CRICKETDATA_API_KEY=        # cricketdata.org key — for fantasy points
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

---

## 11. API Integration

### 11.1 Cricbuzz (RapidAPI) — Schedule & Playing XI

**Base URL:** `https://cricbuzz-cricket.p.rapidapi.com`

| Purpose | Endpoint |
|---------|----------|
| IPL 2026 series schedule | `GET /series/v1/{ipl2026SeriesId}` |
| Match playing XI (after toss) | `GET /mcenter/v1/{matchId}/playing11` |
| Match status & metadata | `GET /mcenter/v1/{matchId}` |

- Used **pre-match only** — fetch schedule at season start, fetch playing XI after toss.
- Not used for live scoring.

### 11.2 cricketdata.org (CricAPI) — Fantasy Points

**Base URL:** `https://api.cricapi.com/v1`

| Purpose | Endpoint |
|---------|----------|
| Per-player fantasy points (live + final) | `GET /match_points?apikey=KEY&id={matchId}&ruleset=0` |
| Full scorecard (backup / display) | `GET /match_scorecard?apikey=KEY&id={matchId}` |
| Squad / player roles | `GET /match_squad?apikey=KEY&id={matchId}` |

- `match_points` returns **player-wise fantasy points** with customizable rulesets.
- `ruleset=0` uses the default scoring rules (configurable in cricketdata.org dashboard).
- **Set up your custom ruleset** in the cricketdata.org dashboard to match Cricbuzz's scoring formula (or define your own). Ruleset ID is stored in env vars.

> **Note:** The `match_points` API uses cricketdata.org match IDs, not Cricbuzz IDs. A mapping between Cricbuzz match IDs and cricketdata.org match IDs must be maintained (can be done manually by admin or by matching team names + date).

### 11.3 Polling Strategy
- **Pre-match:** Fetch playing XI from Cricbuzz after toss → populate team selection
- **During match:** Poll `match_points` (cricketdata.org) every 2–3 minutes for live points
- **Post-match:** Final fetch when match status = "complete" → lock scores, compute results
- **Rate limiting:** Cache all responses; minimum 90-second gap between re-fetches of same match

### 11.4 API Rate Limits to Check
- **Cricbuzz RapidAPI:** Check your plan's monthly call quota (schedule + playing XI = low usage, ~150 calls/season)
- **cricketdata.org:** Check daily/monthly call quota. Live polling every 2 min × 3.5hr match ≈ 105 calls/match × 74 matches ≈ ~7,800 calls/season

---

## 12. Database Schema (Supabase / PostgreSQL)

```sql
-- Users (5 friends)
users (
  id UUID PRIMARY KEY,
  google_id TEXT UNIQUE,
  name TEXT,
  email TEXT UNIQUE,
  is_admin BOOLEAN DEFAULT false,
  created_at TIMESTAMP
)

-- Matches
matches (
  id UUID PRIMARY KEY,
  cricbuzz_match_id TEXT UNIQUE,
  name TEXT,              -- e.g. "MI vs CSK, Match 12"
  match_type TEXT,        -- 'league' | 'qualifier1' | 'qualifier2' | 'eliminator' | 'final'
  team1 TEXT,
  team2 TEXT,
  scheduled_at TIMESTAMP,
  locked_at TIMESTAMP,    -- set by admin after toss
  status TEXT,            -- 'upcoming' | 'locked' | 'live' | 'completed' | 'abandoned'
  base_prize INT,         -- fixed prize in paise or rupees
  rollover_added INT DEFAULT 0,  -- extra prize from previous abandoned/low-participation match
  result_announcement TEXT,
  created_at TIMESTAMP
)

-- Players for a match (fetched from Cricbuzz playing XI after toss)
match_players (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches,
  cricbuzz_player_id TEXT,
  cricketdata_player_id TEXT,  -- for mapping to cricketdata.org points
  name TEXT,
  team TEXT,
  role TEXT,              -- 'BAT' | 'BOWL' | 'ALL' | 'WK'
  fantasy_points DECIMAL(6,1) DEFAULT 0,  -- updated live from cricketdata.org
  is_playing BOOLEAN DEFAULT false,
  last_updated TIMESTAMP
)

-- User team selections per match
teams (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users,
  match_id UUID REFERENCES matches,
  players JSONB,          -- array of cricbuzz_player_ids
  captain_id TEXT,
  vice_captain_id TEXT,
  total_points DECIMAL(6,1),  -- computed after match
  rank INT,               -- 1-5, computed after match
  submitted_at TIMESTAMP,
  UNIQUE(user_id, match_id)
)

-- Match results
match_results (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches,
  user_id UUID REFERENCES users,
  rank INT,
  raw_points DECIMAL(6,1),
  final_points DECIMAL(6,1),   -- after captain/VC multipliers
  prize_won DECIMAL(8,2),
  is_settled BOOLEAN DEFAULT false,
  created_at TIMESTAMP
)

-- Season reserve
season_reserve (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches,
  amount DECIMAL(8,2),
  reason TEXT,            -- 'low_participation' | 'abandoned_leftover'
  created_at TIMESTAMP
)
```

---

## 13. Core Business Logic

### 13.1 Team Lock Flow
1. Admin is notified (in-app) when toss time approaches.
2. Admin fetches playing XI from Cricbuzz → confirms players in admin panel.
3. Admin clicks "Lock Match" → `matches.locked_at` is set, team selection closes.
4. Players can no longer edit teams.

### 13.2 Points Computation (per player)
```
final_points = raw_points × multiplier
  where multiplier = 2.0 if captain, 1.5 if VC, 1.0 otherwise
```

### 13.3 Match Result Computation
1. Fetch final fantasy points for all players from Cricbuzz API.
2. For each user who submitted a team:
   - Compute `total_points` = sum of final_points for their 11 players.
3. Rank users by `total_points` (descending).
4. Determine actual prize pool: `base_prize + rollover_added`, scaled by participant ratio.
5. If participants ≥ 3: award 1st and 2nd (or just 1st if exactly 3).
6. If participants < 3: full prize added to next match's `rollover_added`.
7. Unscaled fraction (from missing participants) added to `season_reserve`.
8. Write rows to `match_results`.

### 13.4 Prize Scaling Formula
```
actual_prize_pool = (base_prize + rollover_added) × (participants / 5)
unspent = (base_prize + rollover_added) × ((5 - participants) / 5)
  → unspent goes to season_reserve
```

---

## 14. Notifications & Communication

- **In-app only.** No email, WhatsApp, or push notifications.
- The home screen always shows the next upcoming match with its status.
- Players are responsible for checking the app before each match.
- Admin posts match result announcements visible on the home screen.

---

## 15. Edge Cases & Rules Summary

| Scenario | Rule |
|----------|------|
| Player misses team submission | 0 points, excluded from prize pool that match |
| Match abandoned / no result | Full prize rolls over to next match |
| < 3 teams submitted | No payout; full prize rolls to next match |
| Exactly 3 teams submitted | Prize pool scaled to 60%; only 1 winner |
| Tie on total points | Prize split equally among tied players |
| Captain did not play | Captain earns 0 points (no VC auto-promotion) |
| Duplicate teams (two players) | Allowed; tie-split rules apply if scores are equal |
| API delay / outage | Admin manually triggers re-fetch; scores stay as last-fetched until refreshed |
| Match rescheduled | Admin updates match time; lock is reset |

---

## 16. Out of Scope

- Payment processing (all money transfers happen via UPI/cash outside the app)
- Push / email / WhatsApp notifications
- Multiple leagues or seasons
- Public registration or invite links
- Auction / draft system
- Mobile native app (iOS/Android)
- Multiple teams per match per user

---

## 17. Open Questions / Risks

1. **Match ID mapping:** Cricbuzz and cricketdata.org use different match IDs. A mapping must be created for each match (either by admin or by matching team names + date). This is a data maintenance task throughout the season.
2. **cricketdata.org ruleset setup:** Before the season, configure a custom scoring ruleset in the cricketdata.org dashboard. Verify it matches your intended scoring formula. Test against a historical IPL match to confirm output.
3. **Toss lock window:** The lock-after-toss window is ~15–20 minutes. Late-checking friends may miss it. An in-app countdown timer is strongly recommended.
4. **IPL 2026 exact match count:** Currently assumed 70 league + 4 playoff = 74 total. If IPL schedule differs, admin should adjust — prize pool math may need manual rebalancing.
5. **cricketdata.org API call quota:** Verify your plan allows ~7,800+ calls/season for live polling. If quota is low, increase polling interval to every 5 minutes during live matches.
6. **Supabase free tier limits:** 500MB storage, 2GB bandwidth/month — ample for 5 users.

---

## 18. Development Phases

### Phase 1 — Foundation
- Next.js project setup, Supabase schema, Google OAuth
- Admin: create users, create matches, set match status
- Basic match listing page

### Phase 2 — Team Selection
- Cricbuzz API integration (playing XI fetch after toss)
- cricketdata.org API integration (squad + player roles)
- Team selection UI with role constraints (no budget), captain/VC
- Team lock mechanism

### Phase 3 — Scoring & Results
- Live score polling from cricketdata.org `match_points` endpoint
- Points computation with captain/VC multipliers
- Match result computation and prize distribution logic
- Match result page

### Phase 4 — Ledger & Leaderboard
- Season leaderboard
- Payout ledger (net balance, per-match log, settle toggle)
- Season reserve tracker

### Phase 5 — Polish
- Admin panel (match management, announcements, score re-fetch)
- Abandoned match / rollover handling
- Season-end reserve award flow
- Mobile-responsive UI

---

*Last updated: April 2026 | Version 1.1 — Updated API strategy: cricketdata.org for fantasy points, no budget cap*
