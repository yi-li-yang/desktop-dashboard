import json, os, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(__file__))
# Keep the unit tests away from the real ~/.claude/usage-guard config.
os.environ["USAGE_GUARD_DIR"] = tempfile.mkdtemp()
import usage_guard as g

NOW = 1_800_000_000
def sl(pct, cost, sid="a", resets=NOW + 3600):
    return {"session_id": sid, "cost": {"total_cost_usd": cost},
            "rate_limits": {"five_hour": {"used_percentage": pct, "resets_at": resets}}}

class T(unittest.TestCase):
    def test_under_limit_allows_everything(self):
        st = g.update_from_statusline({}, sl(80, 5.0), NOW)
        self.assertFalse(g.is_over(st, NOW))
        self.assertIsNone(g.prompt_decision(st, {"prompt": "hi"}, NOW))
        self.assertEqual(g.tool_decision(st, {"session_id": "a"}, NOW), (None, False))

    def test_cost_before_crossing_is_not_overage(self):
        st = g.update_from_statusline({}, sl(99, 5.0), NOW)
        st = g.update_from_statusline(st, sl(100, 5.30), NOW + 1)
        self.assertEqual(g.overage_usd(st), 0.0)
        st = g.update_from_statusline(st, sl(100, 5.55), NOW + 2)
        self.assertAlmostEqual(g.overage_usd(st), 0.25)

    def test_over_blocks_new_prompt_but_override_passes(self):
        st = g.update_from_statusline({}, sl(100, 1.0), NOW)
        self.assertEqual(g.prompt_decision(st, {"prompt": "next task"}, NOW)["decision"], "block")
        self.assertIsNone(g.prompt_decision(st, {"prompt": "  !spill finish it"}, NOW))

    def test_tool_warns_once_then_stops_at_cap(self):
        st = g.update_from_statusline({}, sl(100, 2.0), NOW)
        out, changed = g.tool_decision(st, {"session_id": "a"}, NOW)
        self.assertIn("additionalContext", out["hookSpecificOutput"]); self.assertTrue(changed)
        self.assertEqual(g.tool_decision(st, {"session_id": "a"}, NOW), (None, False))
        st = g.update_from_statusline(st, sl(100, 2.0 + g.CAP_USD), NOW + 5)
        out, _ = g.tool_decision(st, {"session_id": "a"}, NOW + 5)
        self.assertIs(out["continue"], False)

    def test_cap_is_shared_across_sessions(self):
        st = g.update_from_statusline({}, sl(100, 1.0, "a"), NOW)
        st = g.update_from_statusline(st, sl(100, 3.0, "b"), NOW)
        st = g.update_from_statusline(st, sl(100, 1.6, "a"), NOW + 1)
        st = g.update_from_statusline(st, sl(100, 3.5, "b"), NOW + 1)
        self.assertAlmostEqual(g.overage_usd(st), 1.1)
        self.assertIs(g.tool_decision(st, {"session_id": "c"}, NOW + 1)[0]["continue"], False)

    def test_clear_resetting_cost_does_not_lose_overage(self):
        st = g.update_from_statusline({}, sl(100, 4.0), NOW)
        st = g.update_from_statusline(st, sl(100, 4.4), NOW + 1)
        st = g.update_from_statusline(st, sl(100, 0.0), NOW + 2)   # /clear
        st = g.update_from_statusline(st, sl(100, 0.3), NOW + 3)
        self.assertAlmostEqual(g.overage_usd(st), 0.7)

    def test_new_window_clears_everything(self):
        st = g.update_from_statusline({}, sl(100, 4.0), NOW)
        st = g.update_from_statusline(st, sl(100, 6.0), NOW + 1)
        st = g.update_from_statusline(st, sl(3, 6.1, resets=NOW + 20000), NOW + 3700)
        self.assertFalse(g.is_over(st, NOW + 3700)); self.assertEqual(g.overage_usd(st), 0.0)

    def test_window_past_reset_with_no_new_data_is_not_over(self):
        st = g.update_from_statusline({}, sl(100, 1.0), NOW)
        self.assertFalse(g.is_over(st, NOW + 3601))
        self.assertIsNone(g.prompt_decision(st, {"prompt": "x"}, NOW + 3601))

    def test_no_rate_limits_field_is_harmless(self):
        st = g.update_from_statusline({}, {"session_id": "a"}, NOW)
        self.assertFalse(g.is_over(st, NOW))

    def test_end_to_end_cli(self):
        d = tempfile.mkdtemp(); env = dict(os.environ, USAGE_GUARD_DIR=d, USAGE_GUARD_CAP_USD="0.50")
        run = lambda role, payload, *a: subprocess.run([sys.executable, g.__file__, role, *a],
                     input=json.dumps(payload), text=True, capture_output=True, env=env)
        import time; t = int(time.time())
        r = run("statusline", sl(100, 1.0, resets=t + 3600)); self.assertIn("over limit", r.stdout)
        self.assertIn('"block"', run("prompt", {"prompt": "go"}).stdout)
        self.assertIn("additionalContext", run("tool", {"session_id": "a"}).stdout)
        run("statusline", sl(100, 1.6, resets=t + 3600))
        self.assertIn('"continue": false', run("tool", {"session_id": "a"}).stdout)
        r = run("statusline", sl(100, 1.6, resets=t + 3600), "--then", "cat")
        self.assertIn("rate_limits", r.stdout)  # wrapped status line got the same stdin
        self.assertEqual(run("prompt", "not json").returncode, 0)  # fails open

    def test_config_file_switches_guard_off_and_sets_cap(self):
        d = tempfile.mkdtemp(); env = dict(os.environ, USAGE_GUARD_DIR=d)
        run = lambda role, payload: subprocess.run([sys.executable, g.__file__, role],
                     input=json.dumps(payload), text=True, capture_output=True, env=env)
        import time; t = int(time.time())
        run("statusline", sl(100, 1.0, resets=t + 3600))
        run("statusline", sl(100, 1.3, resets=t + 3600))
        self.assertIn('"block"', run("prompt", {"prompt": "go"}).stdout)
        with open(os.path.join(d, "config.json"), "w") as f:
            json.dump({"enabled": True, "cap_usd": 0.25}, f)
        self.assertIn('"continue": false', run("tool", {"session_id": "a"}).stdout)
        with open(os.path.join(d, "config.json"), "w") as f:
            json.dump({"enabled": False, "cap_usd": 0.25}, f)
        self.assertEqual(run("prompt", {"prompt": "go"}).stdout, "")
        self.assertEqual(run("tool", {"session_id": "a"}).stdout, "")
        self.assertIn("guard off", run("statusline", sl(100, 1.3, resets=t + 3600)).stdout)

if __name__ == "__main__":
    unittest.main()
