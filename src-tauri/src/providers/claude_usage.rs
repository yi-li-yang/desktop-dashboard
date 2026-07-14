use super::{ProviderError, StatProvider};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client id (same one the CLI uses).
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// The endpoint rate-limits unknown user agents aggressively; identify as Claude Code.
const USER_AGENT: &str = "claude-code/2.0.14";

pub struct ClaudeUsageProvider {
    client: reqwest::Client,
}

impl ClaudeUsageProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
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

/// Converts the raw endpoint payload into the stable shape the frontend renders.
pub fn normalize(raw: &Value) -> Value {
    json!({
        "session": window(raw, "five_hour"),
        "weekly": window(raw, "seven_day"),
        "weekly_opus": window(raw, "seven_day_opus"),
        "weekly_sonnet": window(raw, "seven_day_sonnet"),
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
            "subscriptionType": "max",
            "extra_usage": {"used": 0}
        });
        let n = normalize(&raw);
        assert_eq!(n["session"]["utilization"], 34.0);
        assert_eq!(n["session"]["resets_at"], "2026-07-14T12:00:00Z");
        assert_eq!(n["weekly"]["utilization"], 61.5);
        assert_eq!(n["weekly_opus"]["utilization"], 12.0);
        assert_eq!(n["weekly_sonnet"], Value::Null);
        assert_eq!(n["plan"], "max");
    }

    #[test]
    fn normalize_missing_windows() {
        let raw = json!({"seven_day": {"utilization": 5.0}});
        let n = normalize(&raw);
        assert_eq!(n["session"], Value::Null);
        assert_eq!(n["weekly"]["utilization"], 5.0);
        assert_eq!(n["weekly"]["resets_at"], Value::Null);
        assert_eq!(n["plan"], Value::Null);
    }

    #[test]
    fn normalize_ignores_malformed_window() {
        let raw = json!({"five_hour": {"resets_at": "x"}}); // no utilization
        let n = normalize(&raw);
        assert_eq!(n["session"], Value::Null);
    }
}
