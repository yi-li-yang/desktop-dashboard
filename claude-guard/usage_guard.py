#!/usr/bin/env python3
"""Claude Code usage guard: once the 5-hour session limit is used up, no new
work starts; the task already running may finish, but only up to a small
dollar cap of usage credits. Stdlib only.

One script, three roles (the first argument picks one):

  statusline  Run as (or in front of) your status line. Saves
              rate_limits.five_hour and this session's cost estimate to the
              shared state file, then runs --then <cmd> with the same stdin,
              or prints a short line. This is the only place Claude Code hands
              a script the session-limit numbers, after every API response.
  prompt      UserPromptSubmit hook. Over the limit: blocks the new prompt.
              A prompt starting with the override word (default "!spill")
              goes through.
  tool        PreToolUse hook. Over the limit: the first tool call of each
              session gets a one-time note telling Claude to wrap up; once
              the overage since the crossing reaches the cap, stops Claude.

State lives in ~/.claude/usage-guard/state.json and is shared by every
session on this machine, so one session seeing the limit blocks them all.

Settings live in ~/.claude/usage-guard/config.json, which the desktop
dashboard's "Usage guard" row writes:
  enabled      false lets everything through (state is still recorded)
  cap_usd      overage allowed after the crossing, summed over all
               sessions in this window (default 1.00)
  threshold    percent of the 5-hour window that counts as "at the limit"
               (default 100)
Environment variables USAGE_GUARD_CAP_USD, USAGE_GUARD_THRESHOLD and
USAGE_GUARD_OVERRIDE (prompt prefix that bypasses the block, default
"!spill") set the defaults when config.json leaves a key out.
USAGE_GUARD_DIR moves the whole folder (default <claude config dir>/usage-guard,
where the Claude config dir is CLAUDE_CONFIG_DIR or ~/.claude).
"""
import json
import os
import subprocess
import sys
import tempfile
import time

OVERRIDE = os.environ.get("USAGE_GUARD_OVERRIDE", "!spill")
STATE_DIR = os.environ.get("USAGE_GUARD_DIR") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
    "usage-guard",
)
STATE_PATH = os.path.join(STATE_DIR, "state.json")
CONFIG_PATH = os.path.join(STATE_DIR, "config.json")

DEFAULTS = {
    "enabled": True,
    "cap_usd": float(os.environ.get("USAGE_GUARD_CAP_USD", "1.00")),
    "threshold": float(os.environ.get("USAGE_GUARD_THRESHOLD", "100")),
}


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        saved = {}
    if isinstance(saved, dict):
        if isinstance(saved.get("enabled"), bool):
            cfg["enabled"] = saved["enabled"]
        for key in ("cap_usd", "threshold"):
            if isinstance(saved.get(key), (int, float)) and saved[key] >= 0:
                cfg[key] = float(saved[key])
    return cfg


CONFIG = load_config()
THRESHOLD = CONFIG["threshold"]
CAP_USD = CONFIG["cap_usd"]


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=".state-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_PATH)  # atomic, so readers never see half a file


def window_live(state, now):
    """The saved window still applies (its reset time hasn't passed)."""
    resets_at = state.get("resets_at")
    return isinstance(resets_at, (int, float)) and now < resets_at


def is_over(state, now):
    return window_live(state, now) and state.get("used_pct", 0) >= THRESHOLD


def overage_usd(state):
    return round(sum(s.get("spent", 0.0) for s in state.get("sessions", {}).values()), 4)


def reset_clock(state):
    return time.strftime("%H:%M", time.localtime(state["resets_at"]))


def update_from_statusline(state, data, now):
    """Fold one status-line payload into the state. Pure, for testing."""
    five = (data.get("rate_limits") or {}).get("five_hour") or {}
    pct = five.get("used_percentage")
    resets_at = five.get("resets_at")
    sid = data.get("session_id") or "unknown"
    cost = float((data.get("cost") or {}).get("total_cost_usd") or 0.0)

    if isinstance(resets_at, (int, float)) and state.get("resets_at") != resets_at:
        # New 5-hour window: forget the old crossing and per-session costs.
        state = {"resets_at": resets_at, "used_pct": 0.0, "sessions": {}}
    if not window_live(state, now):
        # No live window known (none sent yet, or it already reset).
        return {"sessions": {}}
    if isinstance(pct, (int, float)):
        state["used_pct"] = float(pct)
    state["updated_at"] = now

    sessions = state.setdefault("sessions", {})
    s = sessions.get(sid)
    if is_over(state, now):
        state.setdefault("over_since", now)
        if s is None:
            # First sight of this session past the line: its cost so far was
            # covered by the plan; only what comes after counts as overage.
            s = {"last": cost, "spent": 0.0}
        delta = cost - s["last"]
        if delta > 0:  # a drop means /clear restarted the session's counter
            s["spent"] += delta
        s["last"] = cost
        sessions[sid] = s
    return state


def emit(obj):
    sys.stdout.write(json.dumps(obj))


def cmd_statusline(argv):
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except ValueError:
        data = {}
    now = time.time()
    state = update_from_statusline(load_state(), data, now)
    try:
        save_state(state)
    except OSError:
        pass  # never break the status line over the guard
    if len(argv) >= 2 and argv[0] == "--then":
        proc = subprocess.run(argv[1], shell=True, input=raw, text=True)
        return proc.returncode
    if window_live(state, now):
        line = f"session {state.get('used_pct', 0):.0f}% · resets {reset_clock(state)}"
        if not CONFIG["enabled"]:
            line += " · guard off"
        elif is_over(state, now):
            line += f" · over limit, spill ${overage_usd(state):.2f}/${CAP_USD:.2f}"
        print(line)
    return 0


def prompt_decision(state, data, now):
    """Return a hook output dict, or None to allow. Pure, for testing."""
    if not is_over(state, now):
        return None
    prompt = (data.get("prompt") or "").lstrip()
    if OVERRIDE and prompt.startswith(OVERRIDE):
        return None
    return {
        "decision": "block",
        "reason": (
            f"Session limit used up; it resets at {reset_clock(state)}. "
            f"New work waits so usage credits aren't spent. "
            f"Start the prompt with {OVERRIDE} to run it on credits anyway."
        ),
    }


def tool_decision(state, data, now):
    """Return (hook output dict or None, state changed). Pure, for testing."""
    if not is_over(state, now):
        return None, False
    spent = overage_usd(state)
    if spent >= CAP_USD:
        return {
            "continue": False,
            "stopReason": (
                f"Stopped by usage guard: ${spent:.2f} of usage credits spent past "
                f"the session limit (cap ${CAP_USD:.2f}). Resumes after "
                f"{reset_clock(state)}; send a prompt then to continue."
            ),
        }, False
    sid = data.get("session_id") or "unknown"
    warned = state.setdefault("warned", [])
    if sid in warned:
        return None, False
    warned.append(sid)
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": (
                "The plan's session limit is used up, so every further request "
                "is paid from usage credits. Finish only the step in progress "
                "with as few tool calls as possible, leave the work in a state "
                "that can be resumed (save files, note the next step), and stop. "
                "Don't start new subtasks."
            ),
        }
    }, True


def read_hook_input():
    try:
        return json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return {}


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    role, rest = argv[0], argv[1:]
    if role == "statusline":
        return cmd_statusline(rest)
    try:
        data = read_hook_input()
        state = load_state()
        now = time.time()
        if not CONFIG["enabled"]:
            return 0  # switched off: let everything through
        if role == "prompt":
            out = prompt_decision(state, data, now)
        elif role == "tool":
            out, changed = tool_decision(state, data, now)
            if changed:
                save_state(state)
        else:
            return 2
        if out:
            emit(out)
    except Exception:
        # Fail open: a broken guard must never block normal work.
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
