// Usage guard bridge: reads and writes the files that claude-guard/usage_guard.py
// shares with Claude Code, so the Claude box can show the guard's state and
// switch it on or off. Local files only, no network.
//
//   <claude config dir>/usage-guard/config.json  {enabled, cap_usd, threshold}
//                                               written here, read by the hooks
//   <claude config dir>/usage-guard/state.json   written by the status line,
//                                               read here

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Status-line data older than this is treated as "not reporting".
const STALE_SECS: f64 = 6.0 * 3600.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GuardConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_cap")]
    pub cap_usd: f64,
    #[serde(default = "default_threshold")]
    pub threshold: f64,
}

fn default_enabled() -> bool {
    true
}
fn default_cap() -> f64 {
    1.0
}
fn default_threshold() -> f64 {
    100.0
}

impl Default for GuardConfig {
    fn default() -> Self {
        Self { enabled: true, cap_usd: 1.0, threshold: 100.0 }
    }
}

pub fn guard_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("USAGE_GUARD_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()?.join(".claude"),
    };
    Some(base.join("usage-guard"))
}

pub fn load_config(dir: &Path) -> GuardConfig {
    std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Writes config.json atomically (temp file, then rename) so a hook reading
/// it at the same moment sees the old or the new file, never half of one.
pub fn save_config(dir: &Path, cfg: &GuardConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(".config.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg)?)?;
    std::fs::rename(&tmp, dir.join("config.json"))
}

/// Summarises state.json the same way the hooks judge it.
pub fn status(state: Option<&Value>, cfg: &GuardConfig, now_secs: f64) -> Value {
    let Some(state) = state else {
        return json!({"reporting": false});
    };
    let updated_at = state.get("updated_at").and_then(Value::as_f64);
    let reporting = updated_at.is_some_and(|t| now_secs - t < STALE_SECS);
    let resets_at = state.get("resets_at").and_then(Value::as_f64);
    let live = resets_at.is_some_and(|r| now_secs < r);
    let used_pct = state.get("used_pct").and_then(Value::as_f64).unwrap_or(0.0);
    let spill: f64 = state
        .get("sessions")
        .and_then(Value::as_object)
        .map(|m| m.values().filter_map(|s| s.get("spent").and_then(Value::as_f64)).sum())
        .unwrap_or(0.0);
    let over = live && used_pct >= cfg.threshold;
    json!({
        "reporting": reporting,
        "live": live,
        "used_pct": if live { json!(used_pct) } else { Value::Null },
        "resets_at": if live { json!(resets_at) } else { Value::Null },
        "over": over,
        "spill_usd": if over { (spill * 100.0).round() / 100.0 } else { 0.0 },
        "stopped": over && spill >= cfg.cap_usd,
    })
}

pub fn snapshot(now_secs: f64) -> Value {
    let Some(dir) = guard_dir() else {
        return json!({"config": GuardConfig::default(), "status": {"reporting": false}});
    };
    let cfg = load_config(&dir);
    let state: Option<Value> = std::fs::read_to_string(dir.join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    json!({"config": cfg, "status": status(state.as_ref(), &cfg, now_secs)})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dd-guard-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn missing_config_uses_defaults_and_partial_config_fills_in() {
        let d = tmp("defaults");
        assert_eq!(load_config(&d), GuardConfig::default());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("config.json"), r#"{"enabled": false}"#).unwrap();
        let c = load_config(&d);
        assert!(!c.enabled);
        assert_eq!(c.cap_usd, 1.0);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn save_then_load_round_trips() {
        let d = tmp("roundtrip");
        let c = GuardConfig { enabled: false, cap_usd: 0.5, threshold: 98.0 };
        save_config(&d, &c).unwrap();
        assert_eq!(load_config(&d), c);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn status_reports_over_and_spill() {
        let cfg = GuardConfig::default();
        let state = json!({
            "resets_at": 2000.0, "used_pct": 100.0, "updated_at": 990.0,
            "sessions": {"a": {"spent": 0.3}, "b": {"spent": 0.25}}
        });
        let s = status(Some(&state), &cfg, 1000.0);
        assert_eq!(s["over"], true);
        assert_eq!(s["spill_usd"], 0.55);
        assert_eq!(s["stopped"], false);
        assert_eq!(s["reporting"], true);
        let capped = GuardConfig { cap_usd: 0.5, ..cfg };
        assert_eq!(status(Some(&state), &capped, 1000.0)["stopped"], true);
    }

    #[test]
    fn status_after_reset_or_without_data_is_calm() {
        let cfg = GuardConfig::default();
        let state = json!({"resets_at": 2000.0, "used_pct": 100.0, "updated_at": 1.0});
        let s = status(Some(&state), &cfg, 3000.0);
        assert_eq!(s["over"], false);
        assert_eq!(s["live"], false);
        assert_eq!(s["used_pct"], Value::Null);
        assert_eq!(status(None, &cfg, 0.0)["reporting"], false);
    }
}
