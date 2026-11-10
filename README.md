# desktop-dashboard

A lightweight, frosted-glass desktop widget (Tauri v2) made of independent boxes: live Claude Code usage
(session and weekly quota remaining, with reset countdowns, spending and prepaid credits) and today's Octopus Agile electricity prices.

<p align="center"><img src="docs/screenshot.png" width="340" alt="Widget with two boxes on a frosted-glass background: Octopus Agile (current price, half-hourly bar chart, below-average windows) and Claude usage (session and weekly quota bars, extra spending, prepaid credits)"></p>

## How it works

- Reads the OAuth token Claude Code stores in `~/.claude/.credentials.json` (login with `claude` first).
- Polls the same endpoint that powers Claude Code's `/usage` (`GET https://api.anthropic.com/api/oauth/usage`) every 5 minutes, with exponential backoff on rate limits (the endpoint is undocumented and strict about polling).
- Also shows today's (and, once published, tomorrow's) Octopus Agile half-hourly prices for region C (London; `REGION` in `octopus_agile.rs`) from the public Octopus API (no key): the current price, below-average windows, and a glowing "Paid to use" effect when the price is negative.
- **Spend fuse** in the Claude box (see below).
- Every block is its own box with a title row. **Click the title to collapse** the box to just its title (click again to expand), and **drag the title up or down to reorder** the boxes. Order and collapsed state are saved in `settings.json` and restored on launch.
- Frameless transparent window with Windows Acrylic blur; drag it anywhere by the header — position is remembered.

## Spend fuse

Usage credits should only pay for the small spill when a run crosses the
plan's session or weekly limit; everything else can wait for the reset. The
one control that stops credit spend everywhere (claude.ai, the Claude apps,
Claude Duet, Claude Code on any machine) is the account's **monthly spend
limit**, enforced by Anthropic. The fuse is a way of using it:

> Keep the monthly limit at **what you've spent this month + the fuse**
> (default $2).

Then any one run past the limits spends at most the fuse and stops. If it was
worth it, raise the limit by another fuse and carry on; if not, wait for the
reset. You decide at the moment it matters, and nothing else can overspend in
the meantime.

The box shows which state the fuse is in:

| State | Meaning | What to do |
|---|---|---|
| **Armed** | Limit is within one fuse of what you've spent | Nothing |
| **Fuse blown** | Credits stopped at the limit | Raise the limit to spent + fuse to continue now, or wait for the reset |
| **Fuse loose** | More than one fuse of headroom, e.g. at the start of a month when the spend count resets to $0 | Lower the limit to spent + fuse |
| **No fuse** | Credits are on with no monthly limit | Set one |
| **Credits off** | Past a limit, Claude simply waits | Nothing |

**Set limit to $X** copies the amount and opens claude.ai's usage settings;
paste it under Usage credits > Adjust limit. The box re-reads the limit when
you come back to it. Click **$2.00 per run** to change the fuse size. The
dashboard only reads the limit; it never changes your account.

Away from the computer, the fuse still works, because the limit lives on the
account. When Claude stops with the spend limit reached, change it from Settings >
Usage on claude.ai or in the Claude app (where the app offers it), to what
you've spent plus the fuse.

## Develop

```sh
npm install
npm run tauri dev
```

Tests: `npm test` (fuse logic) and `cd src-tauri && cargo test`

## Build

```sh
npm run tauri build
```

## Adding a new stat card

Each stat is a provider (Rust) + card renderer (TS):

1. Add `src-tauri/src/providers/<name>.rs` implementing `StatProvider` (id, poll interval, `fetch()` returning normalized JSON), and register it in `providers::all()`.
2. Add `src/cards/<name>.ts` exporting a render function `(body, payload) => void`, and register it in the `CARDS` map in `src/main.ts` with a `title`, and optionally `meta` (small badge on the right of the title row, e.g. the plan or region) and `tick` (re-evaluate time-dependent text between polls).

Every card is drawn inside its own box by `src/card-frame.ts`, so unrelated blocks stay isolated and get collapse + drag-to-reorder for free. The box style is `.card` in `src/styles.css`. Your renderer only fills the box body: don't add an outer border, background or title row, and put state classes meant for the whole box (like `negative-price`) on `body.closest(".card")`. A new card appears at the end until the user moves it; the default order is `CARDS` order.

The Rust side polls each provider on its own schedule and emits `stats://<id>` events; the frontend renders whatever cards are registered.

## Deferred ideas

- **Remaining API funds** — blocked on Anthropic exposing a credit-balance endpoint ([feature request](https://github.com/anthropics/claude-code/issues/47574)); could be approximated with manual balance entry minus Admin API cost report.
- Autostart with Windows (`tauri-plugin-autostart`).
- Pin-to-desktop layer (behind other windows, Rainmeter-style).
