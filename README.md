# desktop-dashboard

A lightweight, frosted-glass desktop widget (Tauri v2) made of independent boxes: live Claude Code usage
(session and weekly quota remaining, with reset countdowns, spending and prepaid credits) and today's Octopus Agile electricity prices.

<p align="center"><img src="docs/screenshot.png" width="340" alt="Widget with two boxes on a frosted-glass background: Octopus Agile (current price, half-hourly bar chart, below-average windows) and Claude usage (session and weekly quota bars, extra spending, prepaid credits)"></p>

## How it works

- Reads the OAuth token Claude Code stores in `~/.claude/.credentials.json` (login with `claude` first).
- Polls the same endpoint that powers Claude Code's `/usage` (`GET https://api.anthropic.com/api/oauth/usage`) every 5 minutes, with exponential backoff on rate limits (the endpoint is undocumented and strict about polling).
- Also shows today's (and, once published, tomorrow's) Octopus Agile half-hourly prices for region C (London; `REGION` in `octopus_agile.rs`) from the public Octopus API (no key): the current price, below-average windows, and a glowing "Paid to use" effect when the price is negative.
- **Usage credits switch** in the Claude box (see below).
- Every block is its own box with a title row. **Click the title to collapse** the box to just its title (click again to expand), and **drag the title up or down to reorder** the boxes. Order and collapsed state are saved in `settings.json` and restored on launch.
- Frameless transparent window with Windows Acrylic blur; drag it anywhere by the header — position is remembered.

## Usage credits switch

Usage credits stay **off** by default: past the plan's session or weekly limit,
Claude waits for the reset instead of spending the balance. That holds
everywhere (claude.ai, the Claude apps, Claude Duet, Claude Code), because the
switch lives on the account. Claude Duet carries on after the reset; local
Claude Code can wait and continue by itself with `autoContinueAtUsageLimit`.

When a run is worth pushing through, turn credits on for a **fixed allowance**
(default $2): the account's monthly spend limit set to *what you've spent this
month + the allowance*. Anthropic stops the spend there, so turning credits on
can never cost more than the allowance.

The Claude box shows the switch:

| State | Meaning | Button |
|---|---|---|
| **Off** | Past a limit, Claude waits | **Turn on for $2.00** |
| **On · $x left** | Credits may spend up to $x more, then stop | none |
| **Allowance used** | The limit was reached and credits stopped | **Allow $2.00 more** |
| **On · $x open** | More than one allowance is open, e.g. after the monthly reset sets the spend count to $0 | **Limit to $2.00** |
| **On · no limit** | Credits are on without a monthly limit | **Limit to $2.00** |

Each button copies the right limit (spent + allowance) and opens claude.ai's
usage settings: switch Usage credits on if needed and paste the amount under
Adjust limit. The box re-reads the account when you come back. Click
**$2.00 a time** to change the allowance. The dashboard only reads the account;
it never changes it, because there is no public interface for that.

Away from the computer, do the same in Settings > Usage on claude.ai or in the
Claude app (where the app offers it). When you're done pushing through, turn
credits off again.

## Develop

```sh
npm install
npm run tauri dev
```

Tests: `npm test` (credits switch logic) and `cd src-tauri && cargo test`

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
