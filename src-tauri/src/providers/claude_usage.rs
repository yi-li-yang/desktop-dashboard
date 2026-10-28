use super::prepaid_ledger::{self, month_before, Ledger};
use super::{ProviderError, StatProvider};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const ORGS_URL: &str = "https://api.anthropic.com/api/oauth/organizations";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client id (same one the CLI uses).
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// The endpoint rate-limits unknown user agents aggressively; identify as Claude Code.
const USER_AGENT: &str = "claude-code/2.0.14";

pub struct ClaudeUsageProvider {
    client: reqwest::Client,
    org_uuid: Mutex<Option<String>>,
    ledger: Mutex<Ledger>,
}

impl ClaudeUsageProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            org_uuid: Mutex::new(None),
            ledger: Mutex::new(prepaid_ledger::load()),
        }
    }

    /// Fetches the prepaid credit balance. Best-effort: any failure yields
    /// None so the rest of the usage card still renders.
    async fn fetch_prepaid(&self, token: &str) -> Option<Value> {
        let cached = self.org_uuid.lock().ok()?.clone();
        let org = match cached {
            Some(o) => o,
            None => {
                let resp = self
                    .client
                    .get(PROFILE_URL)
                    .bearer_auth(token)
                    .header("anthropic-beta", "oauth-2025-04-20")
                    .header("User-Agent", USER_AGENT)
                    .send()
                    .await
                    .ok()?;
                if !resp.status().is_success() {
                    return None;
                }
                let profile: Value = resp.json().await.ok()?;
                let uuid = profile["organization"]["uuid"].as_str()?.to_string();
                // Only ever interpolated into a URL path; reject anything unexpected.
                if !uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                    return None;
                }
                *self.org_uuid.lock().ok()? = Some(uuid.clone());
                uuid
            }
        };

        let credits_raw = self.get_org_json(token, &org, "prepaid/credits").await?;
        let mut prepaid = prepaid_credits(&credits_raw)?;
        // Bundle counters are optional; the balance still renders without them.
        let bundles_raw = self.get_org_json(token, &org, "prepaid/bundles").await;

        if let Ok(mut ledger) = self.ledger.lock() {
            if apply_ledger(&mut prepaid, &credits_raw, bundles_raw.as_ref(), &mut ledger, now_ms()) {
                prepaid_ledger::save(&ledger);
            }
        }
        Some(prepaid)
    }

    async fn get_org_json(&self, token: &str, org: &str, endpoint: &str) -> Option<Value> {
        let resp = self
            .client
            .get(format!("{ORGS_URL}/{org}/{endpoint}"))
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<Value>().await.ok()
    }
}

fn credentials_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join(".credentials.json"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Reads the full credentials file that Claude Code maintains locally.
fn read_credentials() -> Result<Value, ProviderError> {
    let path = credentials_path().ok_or_else(|| {
        ProviderError::NoCredentials("Could not locate home directory".into())
    })?;
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        ProviderError::NoCredentials(
            "No Claude Code credentials found. Log in with `claude` first.".into(),
        )
    })?;
    serde_json::from_str(&raw)
        .map_err(|_| ProviderError::NoCredentials("Credentials file is not valid JSON".into()))
}

/// Refreshes an expired access token using Claude Code's own OAuth client,
/// and writes the rotated credentials back atomically so Claude Code's login
/// stays valid. Only called when the stored token is already expired, so we
/// don't race a running CLI that would refresh it itself.
async fn refresh_token(client: &reqwest::Client, mut creds: Value) -> Result<String, ProviderError> {
    let refresh = creds["claudeAiOauth"]["refreshToken"]
        .as_str()
        .ok_or_else(|| {
            ProviderError::NoCredentials("Token expired and no refresh token stored".into())
        })?
        .to_string();

    let resp = client
        .post(TOKEN_URL)
        .header("User-Agent", USER_AGENT)
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await
        .map_err(|e| ProviderError::Other(format!("Token refresh network error: {e}")))?;

    if !resp.status().is_success() {
        return Err(ProviderError::NoCredentials(format!(
            "Token refresh failed (HTTP {}). Re-login in Claude Code.",
            resp.status().as_u16()
        )));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| ProviderError::Other(format!("Bad token refresh response: {e}")))?;
    let access = body["access_token"]
        .as_str()
        .ok_or_else(|| ProviderError::Other("Token refresh response missing access_token".into()))?
        .to_string();

    let oauth = &mut creds["claudeAiOauth"];
    oauth["accessToken"] = json!(access);
    if let Some(rt) = body["refresh_token"].as_str() {
        oauth["refreshToken"] = json!(rt);
    }
    if let Some(secs) = body["expires_in"].as_i64() {
        oauth["expiresAt"] = json!(now_ms() + secs * 1000);
    }

    // Atomic write-back: temp file then rename, preserving all other fields.
    if let Some(path) = credentials_path() {
        let tmp = path.with_extension("json.tmp");
        if let Ok(serialized) = serde_json::to_string(&creds) {
            if std::fs::write(&tmp, serialized).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
    Ok(access)
}

/// Returns a currently-valid access token, refreshing it if expired.
async fn access_token(client: &reqwest::Client) -> Result<String, ProviderError> {
    let creds = read_credentials()?;
    let oauth = &creds["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .ok_or_else(|| ProviderError::NoCredentials("Credentials file has no access token".into()))?
        .to_string();
    let expired = oauth["expiresAt"]
        .as_i64()
        .map(|ms| ms <= now_ms())
        .unwrap_or(false);
    if expired {
        refresh_token(client, creds).await
    } else {
        Ok(token)
    }
}

/// Normalizes one usage window object ({utilization, resets_at, ...}) if present.
fn window(raw: &Value, key: &str) -> Option<Value> {
    let w = raw.get(key)?;
    let utilization = w.get("utilization").and_then(Value::as_f64)?;
    Some(json!({
        "utilization": utilization,
        "resets_at": w.get("resets_at").cloned().unwrap_or(Value::Null),
    }))
}

/// Normalizes the extra_usage block (pay-as-you-go spending and out-of-limit tracking) if present.
fn extra_usage(raw: &Value) -> Option<Value> {
    let eu = raw.get("extra_usage")?;
    if eu.is_null() {
        return None;
    }
    let is_enabled = eu.get("is_enabled").and_then(Value::as_bool).unwrap_or(false);

    // In Anthropic's OAuth API, monthly_limit and used_credits are returned in cents.
    let monthly_limit_cents = eu.get("monthly_limit")
        .or_else(|| raw.get("spend").and_then(|s| s.get("limit")).and_then(|l| l.get("amount_minor")))
        .and_then(Value::as_f64);
    let used_cents = eu.get("used_credits")
        .or_else(|| raw.get("spend").and_then(|s| s.get("used")).and_then(|u| u.get("amount_minor")))
        .or_else(|| eu.get("used"))
        .and_then(Value::as_f64);

    let monthly_limit = monthly_limit_cents.map(|c| (c / 100.0 * 100.0).round() / 100.0);
    let used = used_cents.map(|c| (c / 100.0 * 100.0).round() / 100.0);

    let balance = match (monthly_limit, used) {
        (Some(limit), Some(spent)) => Some(((limit - spent).max(0.0) * 100.0).round() / 100.0),
        _ => None,
    };

    let utilization = eu.get("utilization").and_then(Value::as_f64).or_else(|| {
        match (monthly_limit, used) {
            (Some(limit), Some(spent)) if limit > 0.0 => {
                Some(((spent / limit) * 100.0 * 10.0).round() / 10.0)
            }
            _ => None,
        }
    });

    let spend_limit_reached = eu.get("spend_limit_reached")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            match (monthly_limit, used) {
                (Some(limit), Some(spent)) if limit > 0.0 => spent >= limit,
                _ => false,
            }
        });

    // Check for monthly billing reset timestamp (e.g. from extra_usage, spend, or tier reset)
    let resets_at = eu.get("resets_at")
        .or_else(|| raw.get("spend").and_then(|s| s.get("resets_at")))
        .or_else(|| raw.get("iguana_necktie").and_then(|i| i.get("resets_at")))
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    Some(json!({
        "is_enabled": is_enabled,
        "monthly_limit": monthly_limit,
        "used": used,
        "balance": balance,
        "utilization": utilization,
        "spend_limit_reached": spend_limit_reached,
        "resets_at": resets_at,
    }))
}

/// Original size of every credit entry still listed on the credits response.
/// None when the response carries no usable entry list.
fn granted_entries(raw: &Value) -> Option<Vec<i64>> {
    let tranches = raw.get("tranches")?.as_array()?;
    Some(
        tranches
            .iter()
            .filter_map(|t| t.get("granted_amount_minor_units").and_then(Value::as_f64))
            .map(|c| c.round() as i64)
            .collect(),
    )
}

/// Folds the persisted ledger and the bundle-purchase counters into the
/// normalized prepaid payload. Returns true if the ledger changed and should
/// be saved.
fn apply_ledger(
    prepaid: &mut Value,
    credits_raw: &Value,
    bundles_raw: Option<&Value>,
    ledger: &mut Ledger,
    now_ms: i64,
) -> bool {
    let mut changed = false;

    // An empty entry list alongside a positive balance is a glitch, not a
    // fully-depleted account; recording it would make the next poll look like
    // a purchase of everything.
    let balance_cents = credits_raw.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
    if let Some(granted) = granted_entries(credits_raw) {
        if !granted.is_empty() || balance_cents <= 0.0 {
            changed |= ledger.record_grants(granted, now_ms);
        }
    }

    let mut paid_this_month = Value::Null;
    if let Some(b) = bundles_raw {
        let paid = b.get("bundle_paid_this_month_minor_units").and_then(Value::as_f64);
        let month = b
            .get("purchases_reset_at")
            .and_then(Value::as_str)
            .and_then(month_before);
        if let (Some(paid), Some(month)) = (paid, month) {
            changed |= ledger.record_paid(&month, paid.round() as i64);
            paid_this_month = json!(paid.round() / 100.0);
        }
    }

    let dollars = |c: i64| c as f64 / 100.0;
    prepaid["tracking_since_ms"] = if ledger.since_ms > 0 { json!(ledger.since_ms) } else { Value::Null };
    prepaid["credit_seen"] = json!(dollars(ledger.credit_seen_cents()));
    prepaid["credit_added"] = json!(dollars(ledger.added_cents));
    prepaid["paid_this_month"] = paid_this_month;
    prepaid["paid_tracked"] = json!(dollars(ledger.paid_tracked_cents()));
    changed
}

/// Normalizes the prepaid credits response: current balance, the original
/// size of the credit entries that still have balance, and auto-reload
/// settings. Amounts are returned in dollars. Returns None when there is no
/// usable balance.
pub fn prepaid_credits(raw: &Value) -> Option<Value> {
    let cents_to_dollars = |c: f64| (c).round() / 100.0;

    let balance_cents = raw
        .get("amount")
        .and_then(Value::as_f64)
        .or_else(|| {
            raw.get("balance")?
                .get("credits")?
                .get("amount_minor")?
                .as_f64()
        })?;

    let active_cents: Option<f64> = granted_entries(raw).and_then(|g| {
        let sum: i64 = g.iter().sum();
        if sum > 0 { Some(sum as f64) } else { None }
    });

    let auto = raw.get("auto_reload_settings").filter(|a| !a.is_null());
    let auto_enabled = auto
        .and_then(|a| a.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reload_threshold = auto
        .and_then(|a| a.get("threshold_in_minor_units"))
        .and_then(Value::as_f64)
        .map(cents_to_dollars);
    let reload_to = auto
        .and_then(|a| a.get("reload_to_in_minor_units"))
        .and_then(Value::as_f64)
        .map(cents_to_dollars);

    Some(json!({
        "balance": cents_to_dollars(balance_cents),
        "active_credit": active_cents.map(cents_to_dollars),
        "auto_reload": auto_enabled,
        "reload_threshold": reload_threshold,
        "reload_to": reload_to,
    }))
}

/// Normalizes weekly usage breakdown by category (e.g. Claude Code, Chats, Cowork).
fn seven_day_breakdown(raw: &Value) -> Option<Value> {
    let bd = raw.get("seven_day_breakdown")?;
    let rows = bd.get("rows")?.as_array()?;
    let filtered: Vec<Value> = rows
        .iter()
        .filter_map(|r| {
            let pct = r.get("percent")?.as_f64()?;
            if pct <= 0.0 {
                return None;
            }
            let name = r.get("display_name")?.as_str()?;
            Some(json!({
                "name": name,
                "percent": pct as u32,
            }))
        })
        .collect();
    if filtered.is_empty() {
        None
    } else {
        Some(json!(filtered))
    }
}

/// Converts the raw endpoint payload into the stable shape the frontend renders.
pub fn normalize(raw: &Value) -> Value {
    json!({
        "session": window(raw, "five_hour"),
        "weekly": window(raw, "seven_day"),
        "weekly_opus": window(raw, "seven_day_opus"),
        "weekly_sonnet": window(raw, "seven_day_sonnet"),
        "breakdown": seven_day_breakdown(raw),
        "extra_usage": extra_usage(raw),
        "plan": raw.get("subscriptionType")
            .or_else(|| raw.get("rate_limit_tier"))
            .cloned()
            .unwrap_or(Value::Null),
    })
}

#[async_trait::async_trait]
impl StatProvider for ClaudeUsageProvider {
    fn id(&self) -> &'static str {
        "claude-usage"
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_secs(5 * 60)
    }

    async fn fetch(&self) -> Result<Value, ProviderError> {
        let token = access_token(&self.client).await?;
        let resp = self
            .client
            .get(USAGE_URL)
            .bearer_auth(&token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|e| ProviderError::Other(format!("Network error: {e}")))?;

        match resp.status().as_u16() {
            200 => {
                let raw: Value = resp
                    .json()
                    .await
                    .map_err(|e| ProviderError::Other(format!("Bad response: {e}")))?;
                let mut data = normalize(&raw);
                data["prepaid"] = self.fetch_prepaid(&token).await.unwrap_or(Value::Null);
                if data["plan"].is_null() {
                    // The usage response doesn't always carry the plan; the
                    // credentials file does.
                    if let Ok(creds) = read_credentials() {
                        data["plan"] = creds["claudeAiOauth"]["subscriptionType"].clone();
                    }
                }
                Ok(data)
            }
            401 | 403 => Err(ProviderError::NoCredentials(
                "Authentication rejected. Re-login in Claude Code.".into(),
            )),
            429 => {
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(Duration::from_secs);
                Err(ProviderError::RateLimited(retry_after))
            }
            s => Err(ProviderError::Other(format!("HTTP {s}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_full_payload() {
        let raw = json!({
            "five_hour": {"utilization": 34.0, "resets_at": "2026-07-14T12:00:00Z"},
            "seven_day": {"utilization": 61.5, "resets_at": "2026-07-18T00:00:00Z"},
            "seven_day_opus": {"utilization": 12.0, "resets_at": "2026-07-18T00:00:00Z"},
            "seven_day_sonnet": {"utilization": 45.0, "resets_at": "2026-07-18T00:00:00Z"},
            "subscriptionType": "max",
            "extra_usage": {
                "is_enabled": true,
                "monthly_limit": 5000,
                "used_credits": 1250,
                "utilization": 25.0,
                "spend_limit_reached": false,
                "resets_at": "2026-11-05T07:59:00Z"
            },
            "seven_day_breakdown": {
                "rows": [
                    {"display_name": "Claude Code", "percent": 85.0},
                    {"display_name": "Chats", "percent": 15.0},
                    {"display_name": "Empty", "percent": 0.0}
                ]
            }
        });
        let n = normalize(&raw);
        assert_eq!(n["session"]["utilization"], 34.0);
        assert_eq!(n["session"]["resets_at"], "2026-07-14T12:00:00Z");
        assert_eq!(n["weekly"]["utilization"], 61.5);
        assert_eq!(n["weekly_opus"]["utilization"], 12.0);
        assert_eq!(n["weekly_sonnet"]["utilization"], 45.0);
        assert_eq!(n["plan"], "max");

        let bd = n["breakdown"].as_array().unwrap();
        assert_eq!(bd.len(), 2);
        assert_eq!(bd[0]["name"], "Claude Code");
        assert_eq!(bd[0]["percent"], 85);
        assert_eq!(bd[1]["name"], "Chats");
        assert_eq!(bd[1]["percent"], 15);

        let eu = &n["extra_usage"];
        assert_eq!(eu["is_enabled"], true);
        assert_eq!(eu["monthly_limit"], 50.0);
        assert_eq!(eu["used"], 12.5);
        assert_eq!(eu["balance"], 37.5);
        assert_eq!(eu["utilization"], 25.0);
        assert_eq!(eu["spend_limit_reached"], false);
        assert_eq!(eu["resets_at"], "2026-11-05T07:59:00Z");
    }

    #[test]
    fn normalize_extra_usage_limit_reached() {
        let raw = json!({
            "extra_usage": {
                "is_enabled": true,
                "monthly_limit": 2000,
                "used_credits": 2000,
                "spend_limit_reached": true
            }
        });
        let n = normalize(&raw);
        let eu = &n["extra_usage"];
        assert_eq!(eu["is_enabled"], true);
        assert_eq!(eu["monthly_limit"], 20.0);
        assert_eq!(eu["used"], 20.0);
        assert_eq!(eu["balance"], 0.0);
        assert_eq!(eu["utilization"], 100.0);
        assert_eq!(eu["spend_limit_reached"], true);
    }

    #[test]
    fn normalize_extra_usage_disabled() {
        let raw = json!({
            "extra_usage": {
                "is_enabled": false,
                "monthly_limit": null,
                "used_credits": null,
                "utilization": null
            }
        });
        let n = normalize(&raw);
        let eu = &n["extra_usage"];
        assert_eq!(eu["is_enabled"], false);
        assert_eq!(eu["monthly_limit"], Value::Null);
        assert_eq!(eu["used"], Value::Null);
        assert_eq!(eu["balance"], Value::Null);
        assert_eq!(eu["spend_limit_reached"], false);
    }

    #[test]
    fn prepaid_credits_sums_tranches() {
        let raw = json!({
            "amount": 88159,
            "balance": {"money": null, "credits": {"amount_minor": 88159, "exponent": 2}},
            "auto_reload_settings": {
                "enabled": true,
                "threshold_in_minor_units": 20000,
                "reload_to_in_minor_units": 25000
            },
            "tranches": [
                {"remaining_amount_minor_units": 3158, "granted_amount_minor_units": 5000},
                {"remaining_amount_minor_units": 10000, "granted_amount_minor_units": 10000},
                {"remaining_amount_minor_units": 10000, "granted_amount_minor_units": null}
            ]
        });
        let p = prepaid_credits(&raw).unwrap();
        assert_eq!(p["balance"], 881.59);
        assert_eq!(p["active_credit"], 150.0);
        assert_eq!(p["auto_reload"], true);
        assert_eq!(p["reload_threshold"], 200.0);
        assert_eq!(p["reload_to"], 250.0);
    }

    #[test]
    fn prepaid_credits_falls_back_to_nested_balance() {
        let raw = json!({"balance": {"credits": {"amount_minor": 1234}}});
        let p = prepaid_credits(&raw).unwrap();
        assert_eq!(p["balance"], 12.34);
        assert_eq!(p["active_credit"], Value::Null);
        assert_eq!(p["auto_reload"], false);
    }

    #[test]
    fn apply_ledger_tracks_credit_and_paid() {
        let credits = json!({
            "amount": 88159,
            "tranches": [
                {"granted_amount_minor_units": 5000},
                {"granted_amount_minor_units": 25000}
            ]
        });
        let bundles = json!({
            "bundle_paid_this_month_minor_units": 45000,
            "purchases_reset_at": "2026-11-01T00:00:00Z"
        });
        let mut ledger = Ledger::default();
        let mut p = prepaid_credits(&credits).unwrap();
        assert!(apply_ledger(&mut p, &credits, Some(&bundles), &mut ledger, 1000));
        assert_eq!(p["credit_seen"], 300.0);
        assert_eq!(p["credit_added"], 0.0);
        assert_eq!(p["paid_this_month"], 450.0);
        assert_eq!(p["paid_tracked"], 450.0);
        assert_eq!(p["tracking_since_ms"], 1000);

        // A new $100 entry appears on a later poll.
        let credits2 = json!({
            "amount": 98159,
            "tranches": [
                {"granted_amount_minor_units": 5000},
                {"granted_amount_minor_units": 25000},
                {"granted_amount_minor_units": 10000}
            ]
        });
        let mut p2 = prepaid_credits(&credits2).unwrap();
        assert!(apply_ledger(&mut p2, &credits2, Some(&bundles), &mut ledger, 2000));
        assert_eq!(p2["credit_seen"], 400.0);
        assert_eq!(p2["credit_added"], 100.0);
        assert_eq!(p2["tracking_since_ms"], 1000);
    }

    #[test]
    fn apply_ledger_ignores_empty_entry_list_with_balance() {
        let good = json!({"amount": 5000, "tranches": [{"granted_amount_minor_units": 5000}]});
        let glitch = json!({"amount": 5000, "tranches": []});
        let mut ledger = Ledger::default();
        let mut p = prepaid_credits(&good).unwrap();
        apply_ledger(&mut p, &good, None, &mut ledger, 1);
        let mut p = prepaid_credits(&glitch).unwrap();
        assert!(!apply_ledger(&mut p, &glitch, None, &mut ledger, 2));
        let mut p = prepaid_credits(&good).unwrap();
        apply_ledger(&mut p, &good, None, &mut ledger, 3);
        assert_eq!(ledger.added_cents, 0);
        assert_eq!(p["paid_this_month"], Value::Null);
    }

    #[test]
    fn prepaid_credits_missing_balance_is_none() {
        assert!(prepaid_credits(&json!({"tranches": []})).is_none());
    }

    #[test]
    fn normalize_missing_windows() {
        let raw = json!({"seven_day": {"utilization": 5.0}});
        let n = normalize(&raw);
        assert_eq!(n["session"], Value::Null);
        assert_eq!(n["weekly"]["utilization"], 5.0);
        assert_eq!(n["weekly"]["resets_at"], Value::Null);
        assert_eq!(n["extra_usage"], Value::Null);
        assert_eq!(n["plan"], Value::Null);
    }

    #[test]
    fn normalize_ignores_malformed_window() {
        let raw = json!({"five_hour": {"resets_at": "x"}}); // no utilization
        let n = normalize(&raw);
        assert_eq!(n["session"], Value::Null);
    }
}
