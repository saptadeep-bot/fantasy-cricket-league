-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Users table (5 friends)
create table users (
  id uuid primary key default uuid_generate_v4(),
  google_id text unique not null,
  name text not null,
  email text unique not null,
  avatar_url text,
  is_admin boolean default false,
  created_at timestamptz default now()
);

-- Matches table
create table matches (
  id uuid primary key default uuid_generate_v4(),
  cricketdata_match_id text unique not null,
  cricbuzz_match_id text,
  name text not null,
  match_number int,
  match_type text not null check (match_type in ('league', 'qualifier1', 'qualifier2', 'eliminator', 'final')),
  team1 text not null,
  team2 text not null,
  venue text,
  scheduled_at timestamptz not null,
  locked_at timestamptz,
  status text not null default 'upcoming' check (status in ('upcoming', 'locked', 'live', 'completed', 'abandoned')),
  base_prize int not null,
  rollover_added int default 0,
  result_announcement text,
  created_at timestamptz default now()
);

-- Match players (playing XI, populated after toss)
create table match_players (
  id uuid primary key default uuid_generate_v4(),
  match_id uuid references matches(id) on delete cascade,
  cricketdata_player_id text not null,
  cricbuzz_player_id text,
  name text not null,
  team text not null,
  role text not null check (role in ('BAT', 'BOWL', 'ALL', 'WK')),
  fantasy_points decimal(6,1) default 0,
  is_playing boolean default true,
  last_updated timestamptz default now(),
  unique(match_id, cricketdata_player_id)
);

-- User team selections per match
create table teams (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete cascade,
  match_id uuid references matches(id) on delete cascade,
  player_ids text[] not null,
  captain_id text not null,
  vice_captain_id text not null,
  total_points decimal(6,1),
  rank int,
  submitted_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, match_id)
);

-- Match results
create table match_results (
  id uuid primary key default uuid_generate_v4(),
  match_id uuid references matches(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  rank int,
  raw_points decimal(6,1),
  final_points decimal(6,1),
  prize_won decimal(8,2) default 0,
  is_settled boolean default false,
  created_at timestamptz default now(),
  unique(match_id, user_id)
);

-- Season reserve pot
create table season_reserve (
  id uuid primary key default uuid_generate_v4(),
  match_id uuid references matches(id) on delete cascade,
  amount decimal(8,2) not null,
  reason text not null check (reason in ('low_participation', 'abandoned_leftover')),
  created_at timestamptz default now()
);

-- Row Level Security
alter table users enable row level security;
alter table matches enable row level security;
alter table match_players enable row level security;
alter table teams enable row level security;
alter table match_results enable row level security;
alter table season_reserve enable row level security;

-- Policies: all authenticated users can read everything
create policy "Users can read all users" on users for select using (auth.role() = 'authenticated');
create policy "Users can read all matches" on matches for select using (auth.role() = 'authenticated');
create policy "Users can read all match_players" on match_players for select using (auth.role() = 'authenticated');
create policy "Users can read all teams" on teams for select using (auth.role() = 'authenticated');
create policy "Users can read all results" on match_results for select using (auth.role() = 'authenticated');
create policy "Users can read reserve" on season_reserve for select using (auth.role() = 'authenticated');

-- Policies: users can only insert/update their own teams
create policy "Users can insert own team" on teams for insert with check (user_id = (select id from users where google_id = auth.uid()::text));
create policy "Users can update own team" on teams for update using (user_id = (select id from users where google_id = auth.uid()::text));

-- Service role has full access (for server-side operations)
