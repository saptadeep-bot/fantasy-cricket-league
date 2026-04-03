# Fantasy Cricket League — IPL 2026

Private fantasy cricket app for 5 friends.

## Setup

1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env.local` and fill in all values
4. Run the SQL in `supabase/schema.sql` in your Supabase project's SQL editor
5. `npm run dev`

## Environment Variables

See `.env.example` for all required variables.

## First Time Setup (Admin)

1. Go to `/admin/users` and add all 5 friends' Gmail addresses
2. Go to `/admin/matches` and click "Import All 70 Matches"
3. Share the app URL with all friends and have them sign in with Google
