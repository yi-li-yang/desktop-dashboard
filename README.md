# desktop-dashboard

A lightweight, frosted-glass desktop widget (Tauri v2) showing live Claude Code usage:
session (5-hour) and weekly quota remaining, with reset countdowns.

<p align="center"><img src="docs/screenshot.png" width="380" alt="Widget showing Claude session and weekly quota bars on a frosted-glass card"></p>

## How it works

- Reads the OAuth token Claude Code stores in `~/.claude/.credentials.json` (login with `claude` first).
- Polls the same endpoint that powers Claude Code's `/usage` (`GET https://api.anthropic.com/api/oauth/usage`) every 5 minutes, with exponential backoff on rate limits (the endpoint is undocumented and strict about polling).
- Frameless transparent window with Windows Acrylic blur; drag it anywhere by the header — position is remembered.

## Develop

```sh
npm install
npm run tauri dev
```

Rust unit tests: `cd src-tauri && cargo test`

## Build

```sh
npm run tauri build
```

## Adding a new stat card

Each stat is a provider (Rust) + card renderer (TS):

1. Add `src-tauri/src/providers/<name>.rs` implementing `StatProvider` (id, poll interval, `fetch()` returning normalized JSON), and register it in `providers::all()`.
2. Add `src/cards/<name>.ts` exporting a render function, and register it in the `CARDS` map in `src/main.ts`.

The Rust side polls each provider on its own schedule and emits `stats://<id>` events; the frontend renders whatever cards are registered.

## Deferred ideas

- **Remaining API funds** — blocked on Anthropic exposing a credit-balance endpoint ([feature request](https://github.com/anthropics/claude-code/issues/47574)); could be approximated with manual balance entry minus Admin API cost report.
- Autostart with Windows (`tauri-plugin-autostart`).
- Pin-to-desktop layer (behind other windows, Rainmeter-style).
