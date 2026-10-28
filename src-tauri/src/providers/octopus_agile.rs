use super::{ProviderError, StatProvider};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API: &str = "https://api.octopus.energy/v1";
// Agile region (distribution area) letter: C = London.
const REGION: &str = "C";

pub struct OctopusAgileProvider {
    client: reqwest::Client,
    product: Mutex<Option<String>>,
}

impl OctopusAgileProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            product: Mutex::new(None),
        }
    }

    async fn get_json(&self, url: &str) -> Result<Value, ProviderError> {
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| ProviderError::Other(format!("Network error: {e}")))?;
        match resp.status().as_u16() {
            200 => resp
                .json()
                .await
                .map_err(|e| ProviderError::Other(format!("Bad response: {e}"))),
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

    /// Agile product codes are versioned (e.g. AGILE-24-10-01), so look up the
    /// current one rather than hardcoding it.
    async fn product_code(&self) -> Result<String, ProviderError> {
        if let Some(p) = self.product.lock().ok().and_then(|g| g.clone()) {
            return Ok(p);
        }
        let raw = self
            .get_json(&format!("{API}/products/?brand=OCTOPUS_ENERGY&is_variable=true"))
            .await?;
        let code = pick_agile_product(&raw)
            .ok_or_else(|| ProviderError::Other("No Agile product found".into()))?;
        if let Ok(mut g) = self.product.lock() {
            *g = Some(code.clone());
        }
        Ok(code)
    }
}

/// Picks the current import Agile product: code starts with `AGILE-`, isn't
/// the export (`OUTGOING`) tariff and is still on sale.
fn pick_agile_product(raw: &Value) -> Option<String> {
    raw["results"]
        .as_array()?
        .iter()
        .filter(|p| p["available_to"].is_null())
        .filter_map(|p| p["code"].as_str())
        .filter(|c| c.starts_with("AGILE-") && !c.contains("OUTGOING"))
        .max()
        .map(String::from)
}

/// Converts the raw unit-rates payload (newest first) into ascending slots.
pub fn normalize(raw: &Value, product: &str) -> Value {
    let mut slots: Vec<(String, String, f64)> = raw["results"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    Some((
                        r["valid_from"].as_str()?.to_string(),
                        r["valid_to"].as_str()?.to_string(),
                        r["value_inc_vat"].as_f64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    slots.sort_by(|a, b| a.0.cmp(&b.0));
    json!({
        "region": REGION,
        "product": product,
        "slots": slots
            .into_iter()
            .map(|(start, end, p)| json!({ "start": start, "end": end, "p": p }))
            .collect::<Vec<_>>(),
    })
}

/// Formats unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (UTC).
fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Days since 1970-01-01 -> civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[async_trait::async_trait]
impl StatProvider for OctopusAgileProvider {
    fn id(&self) -> &'static str {
        "octopus-agile"
    }

    fn poll_interval(&self) -> Duration {
        // Tomorrow's prices appear around 4pm UK time; 30 min picks them up.
        Duration::from_secs(30 * 60)
    }

    async fn fetch(&self) -> Result<Value, ProviderError> {
        let product = self.product_code().await?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let url = format!(
            "{API}/products/{product}/electricity-tariffs/E-1R-{product}-{REGION}/standard-unit-rates/\
             ?period_from={}&period_to={}&page_size=200",
            iso_utc(now.saturating_sub(24 * 3600)),
            iso_utc(now + 48 * 3600),
        );
        let raw = match self.get_json(&url).await {
            Ok(v) => v,
            Err(e) => {
                // The product may have been retired; re-discover next time.
                if let Ok(mut g) = self.product.lock() {
                    *g = None;
                }
                return Err(e);
            }
        };
        Ok(normalize(&raw, &product))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_sorts_ascending_and_keeps_negative_prices() {
        let raw = json!({ "results": [
            { "value_inc_vat": 12.5, "valid_from": "2026-10-28T01:00:00Z", "valid_to": "2026-10-28T01:30:00Z" },
            { "value_inc_vat": -3.2, "valid_from": "2026-10-28T00:30:00Z", "valid_to": "2026-10-28T01:00:00Z" },
            { "value_inc_vat": 20.0, "valid_from": "2026-10-28T00:00:00Z", "valid_to": "2026-10-28T00:30:00Z" },
        ]});
        let out = normalize(&raw, "AGILE-24-10-01");
        let slots = out["slots"].as_array().unwrap();
        assert_eq!(slots.len(), 3);
        assert_eq!(slots[0]["start"], "2026-10-28T00:00:00Z");
        assert_eq!(slots[1]["p"], -3.2);
        assert_eq!(slots[2]["end"], "2026-10-28T01:30:00Z");
        assert_eq!(out["region"], "C");
        assert_eq!(out["product"], "AGILE-24-10-01");
    }

    #[test]
    fn normalize_handles_empty_and_malformed_rows() {
        assert_eq!(normalize(&json!({}), "X")["slots"], json!([]));
        let raw = json!({ "results": [{ "valid_from": "2026-10-28T00:00:00Z" }] });
        assert_eq!(normalize(&raw, "X")["slots"], json!([]));
    }

    #[test]
    fn picks_current_import_product_not_export() {
        let raw = json!({ "results": [
            { "code": "AGILE-OUTGOING-19-05-13", "available_to": null },
            { "code": "AGILE-23-12-06", "available_to": "2024-10-01T00:00:00Z" },
            { "code": "AGILE-24-10-01", "available_to": null },
            { "code": "GO-VAR-22-10-14", "available_to": null },
        ]});
        assert_eq!(pick_agile_product(&raw).as_deref(), Some("AGILE-24-10-01"));
        assert_eq!(pick_agile_product(&json!({ "results": [] })), None);
    }

    #[test]
    fn formats_iso_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_782_605_400), "2026-06-28T00:10:00Z");
        // Leap day.
        assert_eq!(iso_utc(1_709_210_096), "2024-02-29T12:34:56Z");
    }
}
