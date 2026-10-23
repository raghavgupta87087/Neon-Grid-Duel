# Neon Grid Duel

A responsive, neon-styled real-time Tic-Tac-Toe game built with React, Vite, Supabase PostgreSQL, and Supabase Realtime.

## Features

- Two-player rooms with short shareable codes
- Server-validated alternating turns
- Realtime board synchronization with polling recovery
- Win, draw, scoreboard, rematch, and reconnect-friendly sessions
- Responsive desktop and mobile design
- No player account required

## Requirements

- Node.js 20+
- A Supabase project
- GitHub account (for source control)
- Vercel account (for hosting)

## 1. Configure Supabase

1. Create a project at https://supabase.com.
2. Open **SQL Editor** in the Supabase dashboard.
3. Paste and run `supabase/migrations/001_neon_grid_duel.sql`.
4. In **Project Settings → API**, copy the Project URL and publishable/anon key.
5. Create `.env` from `.env.example` and fill in:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

The browser key is designed to be public. Never put a Supabase `service_role` or secret key in a `VITE_` variable or commit it to Git.

## 2. Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. For real multiplayer, the Supabase migration and `.env` values must be configured.

## 3. Deploy to GitHub and Vercel

```bash
git init
git add .
git commit -m "Build Neon Grid Duel"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/neon-grid-duel.git
git push -u origin main
```

Then:

1. Import the repository at https://vercel.com/new.
2. Keep the build command `npm run build` and output directory `dist`.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel Project Settings → Environment Variables.
4. Deploy and open the assigned `https://*.vercel.app` URL.
5. Test with two different devices/browsers and two different player names.

The included `vercel.json` handles SPA routes and query-string room invites.

## Database/security notes

Game-changing operations run through PostgreSQL functions that lock the room row and validate player identity, turn, and cell occupancy. Direct table privileges are revoked from browser roles. Room codes are invite links, not a high-security access-control boundary. For a larger production launch, add rate limiting, server-issued signed player tokens, room expiration/cleanup, and abuse monitoring.

## Known implementation notes

- This version uses a browser-generated persistent player ID. It is convenient for a challenge demo but is not a strong authentication credential. A production version should use authenticated/cryptographically signed player sessions.
- Realtime is paired with a five-second refresh fallback.
- The UI has a preview state when Supabase is not configured, but real cross-device play requires a configured Supabase project.
