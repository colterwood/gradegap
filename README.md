# GradeGap

A personal, local-only web app that finds sports cards with the biggest price
disparity between another grader's slab and **PSA**, using data from your own
[Card Ladder](https://app.cardladder.com) account. Pick one or more graders
(**SGC**, **BGS**) with the Grader checkboxes; PSA is always the compare-to
side and every row is tagged with its grader. It compares like grades only —
grader 10 vs PSA 10, 9 vs 9, 8 vs 8, 7 vs 7; a 9 is never compared against a
10. Pick any subset of grades with the **Grade** checkboxes; a card can appear
once per grade per grader. (SGC's rarer "10 Pristine" and BGS's "Black Label"
are deliberately excluded from the 10 comparison, and BGS half grades like 9.5
aren't crawled — they have no like-for-like PSA counterpart.)

Everything runs on your computer. Your Card Ladder login happens in a real
browser window on your machine; your password is never stored (unless you opt
in via `.env`) and never leaves your computer.

## How it works

- Click **Sync** in the web UI → a Chromium window (driven by Playwright,
  logged in as you) opens the Ladder and pulls its grade-filtered list API in
  bulk: one pass per grader-and-grade condition (**SGC**, **BGS**, and
  **PSA** × grades **10, 9, 8, 7** — twelve passes, driven by
  `COMPARE_GRADERS`/`COMPARE_GRADES` in `src/config.js`). Each page
  of that API returns many cards *with their values already on the row*, so
  there are **no per-card page visits** — a full catalog sync is a few hundred
  JSON requests (minutes), not one page load per card.
- Both grades are joined locally by Card Ladder's own card id (`psaSpecId`),
  and everything is stored in a local SQLite database (`data/gradegap.db`), so
  the results page is instant and works offline.
- The table ranks cards by disparity — toggleable between **% difference**
  and **$ difference**, between **CL Value** and **Last Sale** price basis,
  and filterable by grader (SGC / BGS), grade (7–10), liquidity (last-sale
  recency; defaults to green — both sides sold in the last 3 months), maximum
  grader-side price (0 = no cap), minimum dollar gap (**Min $ Diff**), minimum percentage
  gap (**Min % Diff**, default 15%), and player. **Grade** and **Grader**
  columns show which comparison a row came from, and the Sales No columns show
  each side's Number of Sales. The default sort is biggest $ Diff first. Every
  row links to the card's page on Card Ladder.

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

- A sync pages through every grader × grade list (SGC/BGS/PSA × 10/9/8/7 — a
  few hundred requests total, ~10 minutes). The progress bar shows where it is,
  **Cancel** stops it cleanly, and an interrupted sync can be **Resumed**.
- If Card Ladder logs you out mid-sync, the run stops with a message — just
  `npm run login` again and Resume.

## Marketplace watcher

Tick the **Watch** box on any row of the results table and GradeGap will hunt
live marketplaces for that exact card + slab (e.g. "1986 Fleer Jordan #57
SGC 10") on a schedule, while the app is running. Everything found lands in
the **Watched** tab: which site, current price (shown in USD; other
currencies converted at daily rates), auction vs Buy It Now, and — for
auctions — the end time with a live countdown. Each listing carries a match
confidence score: titles that fail the hard checks (year, player, exact
grader+grade) are discarded outright, everything else is kept and low
scorers are highlighted so *you* make the final call (Dismiss clears them).

- **Checking cadence**: every `WATCH_INTERVAL_MIN` minutes (default 30)
  while the server runs, plus a **Check now** button. Set `0` for
  manual-only.
- **Phone pushes** (optional): install the [ntfy](https://ntfy.sh) app,
  subscribe to a long random topic name, and set `NTFY_TOPIC` in `.env`.
  You get one aggregate push per check when new listings appear ("7 new
  listings for your GradeGap watchlist") and one reminder when watched
  auctions enter their last `WATCH_REMIND_MIN` minutes (default 24h).
- **Sources** (`WATCH_SOURCES`): each marketplace is a small adapter under
  `src/marketplace/sources/`. Shipping today:
  - `ebay` — the official eBay Browse API (no scraping) across the US,
    Canadian, UK, German, French, and Italian marketplaces
    (`EBAY_MARKETPLACES`). Needs a free developer keyset — see
    `.env.example`.
  - `shopify` — a generic adapter for any Shopify card shop's public search
    (built for the Canadian shops: Flip Collectibles, Mintink, Overtime, …);
    list domains in `SHOPIFY_SHOPS`.
  - More (Goldin, Heritage, Fanatics Collect, Pristine, CIA, COMC, MySlabs,
    HiBid, Catawiki, …) slot in behind the same interface — the plan lives in
    the repo history; each one is a single new file in
    `src/marketplace/sources/` plus a `WATCH_SOURCES` entry.
- **Per-watch cap**: the Watched tab's *Max $* column skips new listings
  above a USD price; the *On* toggle pauses a watch without losing its
  listing history; ✕ deletes the watch and its history (unticking the Watch
  box does the same).
- Mock mode (`npm run mock`) includes a fixture marketplace, so the whole
  watch → check → matches flow works with zero credentials.

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
src/db/            schema + all SQL (disparity ranking is a single query)
src/sync/          sync orchestration: work queue, progress, resume, cancel
src/scraper/       browser session, network capture, and the Card Ladder
                   adapter (endpoints.js + adapter.js = the only files that
                   know Card Ladder's response shapes)
src/scraper/mock   fixture-based fake Card Ladder for development
src/marketplace/   the watcher: match.js (query building + title scoring),
                   watchRunner.js (scheduler + work queue + notifications),
                   fx.js (USD conversion), notify.js (ntfy pushes), and
                   sources/ (one small adapter per marketplace + mock)
public/            the web UI (no build step)
```

## A note on Card Ladder's terms

This tool automates a logged-in browser against your own paid account, at
human-like speeds, for personal research. That said, automated access likely
sits outside Card Ladder's terms of service — use at your own discretion and
keep the rate limits polite.
