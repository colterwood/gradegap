# GradeGap

A personal, local-only web app that finds sports cards with the biggest price
disparity between their **SGC 10 Gem Mint** and **PSA 10** grades, using data
from your own [Card Ladder](https://app.cardladder.com) account. (SGC's rarer
"10 Pristine" is deliberately excluded from the comparison.)

Everything runs on your computer. Your Card Ladder login happens in a real
browser window on your machine; your password is never stored (unless you opt
in via `.env`) and never leaves your computer.

## How it works

- Click **Sync** in the web UI → a Chromium window (driven by Playwright,
  logged in as you) opens the Ladder and pulls its grade-filtered list API in
  bulk: one pass filtered to **SGC 10 Gem Mint**, one to **PSA 10**. Each page
  of that API returns many cards *with their values already on the row*, so
  there are **no per-card page visits** — a full catalog sync is a few hundred
  JSON requests (minutes), not one page load per card.
- Both grades are joined locally by Card Ladder's own card id (`psaSpecId`),
  and everything is stored in a local SQLite database (`data/gradegap.db`), so
  the results page is instant and works offline.
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
#    so the first task is to capture the API behind "the Ladder":
npm run discover
```

Discovery opens the Ladder (Card Ladder's grade-filterable ranked list) and
records all backend traffic to `captures/<timestamp>/` while you browse. The
terminal walks you through it: filter Condition → **SGC 10 - Gem Mint**, page
through a few pages, switch the filter to **PSA 10**, page through again, and
optionally open one card and flip its condition selector. Then Ctrl-C.

> **Why discovery matters:** the Ladder's bulk list API is what makes this
> scale — pulling whole grade-filtered pages of cards-with-values at once
> instead of visiting every card page individually. The capture pins down
> that endpoint's real URL, response shape, and pagination so the sync can be
> bound to it in `src/scraper/cardladder/endpoints.js` and `adapter.js`.
> That finalization is a one-time step; captures contain no passwords or
> tokens (auth traffic is skipped and header values are redacted).

```bash
# 3. Run the app
npm start
# open http://localhost:4000 and click Sync
```

## Everyday use

```bash
npm start          # → http://localhost:4000, click Sync when you want fresh data
```

- A sync pages through the whole SGC 10 Gem Mint and PSA 10 lists (a few
  hundred requests total, a few minutes). The progress bar shows where it is,
  **Cancel** stops it cleanly, and an interrupted sync can be **Resumed**.
- If Card Ladder logs you out mid-sync, the run stops with a message — just
  `npm run login` again and Resume.

## Scoping to specific players (optional)

By default the sync covers the **whole catalog** (every card with an SGC 10
Gem Mint value — the limiting side, only ~500 cards). To restrict it to
certain players, list them in `config/players.json`:

```json
[
  { "name": "Michael Jordan" },
  { "name": "LeBron James" }
]
```

An empty array (`[]`, the default) means everything. Restart and Sync.

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
