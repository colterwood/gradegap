# GradeGap

A personal, local-only web app that finds sports cards with the biggest price
disparity between their **SGC 10** and **PSA 10** grades, using data from your
own [Card Ladder](https://app.cardladder.com) account.

Everything runs on your computer. Your Card Ladder login happens in a real
browser window on your machine; your password is never stored (unless you opt
in via `.env`) and never leaves your computer.

## How it works

- Click **Sync** in the web UI → a Chromium window (driven by Playwright,
  logged in as you) browses Card Ladder like a person would, with polite
  3–7 second pauses, and records the price data Card Ladder's own pages load.
- Results are stored in a local SQLite database (`data/gradegap.db`), so the
  results page is instant and works offline.
- The table ranks cards by disparity — toggleable between **% difference**
  and **$ difference**, between **CL Value** and **Last Sale** price basis,
  and filterable by direction (SGC cheaper / PSA cheaper), minimum price, and
  player. Every row links to the card's page on Card Ladder.

## Setup (first time)

Requires [Node.js 20+](https://nodejs.org).

```bash
npm install
npx playwright install chromium
cp .env.example .env        # defaults are fine; nothing is required
```

## First run

```bash
# 1. Log in once. A browser window opens — sign in to Card Ladder yourself,
#    with whatever method your account actually uses (email/password,
#    "Sign in with Apple", 2FA, etc). The session is saved locally in
#    ./profile. If you ever log in with the wrong account by mistake, delete
#    the ./profile folder and run this again — otherwise it keeps reusing
#    the saved (wrong) session instead of prompting you to log in.
npm run login

# 2. IMPORTANT — discovery run. Card Ladder's internal API is undocumented,
#    so the first task is to capture what its pages actually load:
npm run discover
```

Discovery opens Card Ladder and walks the Michael Jordan pages, recording all
backend traffic to `captures/<timestamp>/`. Browse around yourself too — open
the player page and a few cards, look at PSA 10 and SGC 10 prices — then hit
Ctrl-C in the terminal.

> **Why discovery matters:** the parsers in
> `src/scraper/cardladder/adapter.js` were written against *predicted*
> response shapes (plain JSON, Firestore, Algolia). They're heuristic and may
> work as-is — but if a sync finds 0 cards or 0 prices, the raw payloads land
> in `captures/failures/` and the capture files from discovery are exactly
> what's needed to fix the matchers in `endpoints.js` and `adapter.js`.
> That finalization is a one-time step.

```bash
# 3. Run the app
npm start
# open http://localhost:4000 and click Sync
```

## Everyday use

```bash
npm start          # → http://localhost:4000, click Sync when you want fresh data
```

- A sync visits every card once (~3–7s per card). Michael Jordan alone is a
  few hundred cards, so expect a sync to take a while — the progress bar
  shows where it is, **Cancel** stops it cleanly, and an interrupted sync can
  be **Resumed** without redoing finished cards.
- If Card Ladder logs you out mid-sync, the run stops with a message — just
  `npm run login` again and Resume.

## Adding players

Edit `config/players.json`:

```json
[
  { "name": "Michael Jordan", "searchTerm": "Michael Jordan", "enabled": true },
  { "name": "LeBron James", "searchTerm": "LeBron James", "enabled": true }
]
```

Restart the server and Sync. (Start small — every enabled player's full card
list is visited on each sync.)

## Development without Card Ladder

```bash
npm run mock       # full app against built-in fixture data — no login needed
npm test           # disparity math, sync/resume/cancel, and parser tests
```

## Layout

```
src/db/          schema + all SQL (disparity ranking is a single query)
src/sync/        sync orchestration: work queue, progress, resume, cancel
src/scraper/     browser session, network capture, and the Card Ladder
                 adapter (endpoints.js + adapter.js = the only files that
                 know Card Ladder's response shapes)
src/scraper/mock fixture-based fake Card Ladder for development
public/          the web UI (no build step)
```

## A note on Card Ladder's terms

This tool automates a logged-in browser against your own paid account, at
human-like speeds, for personal research. That said, automated access likely
sits outside Card Ladder's terms of service — use at your own discretion and
keep the rate limits polite.
