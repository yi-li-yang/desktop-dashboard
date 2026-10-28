// Persistent record of prepaid credit the widget has observed. The credits
// endpoint only lists entries that still have balance, so lifetime purchases
// can't be read back; instead we diff consecutive polls to catch new entries
// and remember the dollars paid per month. Amounts are in cents.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ledger {
    /// When tracking began (unix ms); 0 until the first successful poll.
    pub since_ms: i64,
    /// Original size of every credit entry seen on the previous poll.
    pub last_granted: Vec<i64>,
    /// Sum of the entries that already existed when tracking began.
    pub baseline_cents: i64,
    /// Sum of entries that appeared after tracking began.
    pub added_cents: i64,
    /// Dollars actually paid for credit bundles, by "YYYY-MM".
    pub paid_by_month: BTreeMap<String, i64>,
}

fn path() -> Option<PathBuf> {
    // Matches Tauri's app_config_dir for this app identifier, next to settings.json.
    dirs::config_dir().map(|d| d.join("com.yili.desktop-dashboard").join("prepaid_ledger.json"))
}

pub fn load() -> Ledger {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(ledger: &Ledger) {
    let Some(path) = path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(ledger) {
        // Temp file then rename so a crash can't leave a half-written ledger.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn counts(items: &[i64]) -> BTreeMap<i64, i64> {
    let mut m = BTreeMap::new();
    for &c in items {
        *m.entry(c).or_insert(0) += 1;
    }
    m
}

impl Ledger {
    /// Records the entries currently listed. Returns true if anything changed.
    pub fn record_grants(&mut self, mut granted: Vec<i64>, now_ms: i64) -> bool {
        granted.sort_unstable();
        if self.since_ms == 0 {
            self.since_ms = now_ms;
            self.baseline_cents = granted.iter().sum();
            self.last_granted = granted;
            return true;
        }

        // Entries that vanished were used up; entries beyond what we saw before are new.
        let before = counts(&self.last_granted);
        let mut added = 0;
        for (size, n) in counts(&granted) {
            let extra = n - before.get(&size).copied().unwrap_or(0);
            if extra > 0 {
                added += size * extra;
            }
        }
        let changed = added > 0 || granted != self.last_granted;
        self.added_cents += added;
        self.last_granted = granted;
        changed
    }

    /// Records dollars paid so far in a month. Only ever grows within a month.
    pub fn record_paid(&mut self, month: &str, cents: i64) -> bool {
        let entry = self.paid_by_month.entry(month.to_string()).or_insert(-1);
        if cents > *entry {
            *entry = cents;
            true
        } else {
            false
        }
    }

    pub fn credit_seen_cents(&self) -> i64 {
        self.baseline_cents + self.added_cents
    }

    pub fn paid_tracked_cents(&self) -> i64 {
        self.paid_by_month.values().filter(|&&c| c > 0).sum()
    }
}

/// The calendar month a bundle-purchase counter covers, derived from its reset
/// timestamp ("2026-11-01T00:00:00Z" -> "2026-10").
pub fn month_before(reset_at: &str) -> Option<String> {
    let year: i32 = reset_at.get(0..4)?.parse().ok()?;
    let month: u32 = reset_at.get(5..7)?.parse().ok()?;
    if reset_at.get(4..5)? != "-" || !(1..=12).contains(&month) {
        return None;
    }
    let (y, m) = if month == 1 { (year - 1, 12) } else { (year, month - 1) };
    Some(format!("{y:04}-{m:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_poll_sets_baseline() {
        let mut l = Ledger::default();
        assert!(l.record_grants(vec![25000, 5000, 10000], 1000));
        assert_eq!(l.since_ms, 1000);
        assert_eq!(l.baseline_cents, 40000);
        assert_eq!(l.added_cents, 0);
        assert_eq!(l.credit_seen_cents(), 40000);
    }

    #[test]
    fn new_entry_counts_as_added() {
        let mut l = Ledger::default();
        l.record_grants(vec![10000, 10000], 1);
        assert!(l.record_grants(vec![10000, 10000, 25000], 2));
        assert_eq!(l.added_cents, 25000);
        assert_eq!(l.credit_seen_cents(), 45000);
    }

    #[test]
    fn depleted_entry_is_not_a_purchase() {
        let mut l = Ledger::default();
        l.record_grants(vec![5000, 10000], 1);
        assert!(l.record_grants(vec![10000], 2));
        assert_eq!(l.added_cents, 0);
        // The same size reappearing is a new purchase, not the old one returning.
        assert!(l.record_grants(vec![5000, 10000], 3));
        assert_eq!(l.added_cents, 5000);
    }

    #[test]
    fn unchanged_poll_changes_nothing() {
        let mut l = Ledger::default();
        l.record_grants(vec![10000], 1);
        assert!(!l.record_grants(vec![10000], 2));
        assert_eq!(l.added_cents, 0);
    }

    #[test]
    fn paid_only_grows_within_a_month() {
        let mut l = Ledger::default();
        assert!(l.record_paid("2026-10", 45000));
        assert!(!l.record_paid("2026-10", 20000));
        assert!(l.record_paid("2026-11", 9000));
        assert_eq!(l.paid_tracked_cents(), 54000);
    }

    #[test]
    fn zero_paid_month_is_recorded_without_inflating_total() {
        let mut l = Ledger::default();
        assert!(l.record_paid("2026-09", 0));
        assert_eq!(l.paid_tracked_cents(), 0);
    }

    #[test]
    fn month_before_handles_year_wrap_and_bad_input() {
        assert_eq!(month_before("2026-11-01T00:00:00Z").as_deref(), Some("2026-10"));
        assert_eq!(month_before("2027-01-01T00:00:00Z").as_deref(), Some("2026-12"));
        assert_eq!(month_before("garbage"), None);
        assert_eq!(month_before("2026-13-01"), None);
    }
}
