# Usage guard for Claude Code

Keeps usage credits for the one thing they are needed for: the small,
unavoidable spill when a task that is already running crosses the 5-hour
session limit. Everything else waits for the limit to reset.

Once the session limit is used up:

- **New prompts are blocked** with the reset time. Start a prompt with
  `!spill` to run it on credits anyway.
- **The task already running may finish.** On its first tool call past the
  limit, Claude is told to wrap up and leave the work resumable.
- **It is stopped at the cap.** When the overage since the crossing, summed
  over every Claude Code session on this machine, reaches the cap (default
  $1.00), Claude is stopped.

The desktop dashboard's Claude box has a **Usage guard** row: switch the guard
on or off, click the cap to change it, and see whether it is standing by, over
the limit, or has stopped a task.

## What it can and can't stop

It only works in Claude Code running on this computer. claude.ai, the Claude
apps and Claude Code sessions in the cloud run no local hooks, so past the
limit they draw on usage credits as usual. For those, the only controls are
the account's usage-credits switch and monthly spend limit (Settings > Usage
on claude.ai).

## How it works

Hooks don't receive usage data; the status line does. After every API
response Claude Code hands the status line command
`rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at` and
`cost.total_cost_usd`. `usage_guard.py statusline` saves them to
`~/.claude/usage-guard/state.json`, which every session and the dashboard read.

- "Over the limit" means the 5-hour window is at or above the threshold
  (default 100%) and its reset time hasn't passed.
- The overage is the rise in each session's `cost.total_cost_usd` after it was
  first seen past the limit. That figure is Claude Code's list-price estimate,
  not the billed amount, but usage credits are charged at API rates, so it is
  close.
- How small the spill gets: the cap plus the last request. In a long session
  one request can cost tens of cents, more if it misses the prompt cache.

Settings live in `~/.claude/usage-guard/config.json` (`enabled`, `cap_usd`,
`threshold`), which the dashboard writes. The hooks fail open: if anything goes
wrong they let the request through rather than block your work.

## Install

1. Copy `usage_guard.py` to `~/.claude/usage-guard/usage_guard.py`.
2. Merge `settings.example.json` into `~/.claude/settings.json`. On Windows,
   use `python` instead of `python3` if that is what runs Python there.
3. If you already have a status line, keep it by wrapping it:
   `python3 ~/.claude/usage-guard/usage_guard.py statusline --then "<your current command>"`.
4. Start a Claude Code session and send one message. The dashboard row should
   change from "Waiting for Claude Code's status line" to "Standing by".

## Known gaps

- Not yet verified on a real crossing: whether `five_hour.used_percentage`
  reaches and stays at 100 while requests run on credits. If it stops short,
  lower `threshold` in `config.json` (for example to 99).
- A turn that never calls a tool can't be stopped at the cap, since the stop
  happens before tool calls.
- Turns Claude Code starts by itself (scheduled `/loop` tasks, messages from
  other sessions) may not go through the prompt block; their tool calls still
  hit the cap.
- The status line doesn't run in non-interactive `claude -p` runs, so those
  don't update the state.

## Test

```sh
python3 claude-guard/test_usage_guard.py
```
