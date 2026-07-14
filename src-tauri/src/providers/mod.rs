pub mod claude_usage;

use std::time::Duration;

#[derive(Debug)]
pub enum ProviderError {
    /// No credentials available; not retryable until the user acts.
    NoCredentials(String),
    /// Server asked us to slow down; retry after the given duration if known.
    RateLimited(Option<Duration>),
    /// Any other failure (network, HTTP status, parse); retry with backoff.
    Other(String),
}

impl ProviderError {
    /// Short machine-readable kind for the frontend to switch on.
    pub fn kind(&self) -> &'static str {
        match self {
            ProviderError::NoCredentials(_) => "no_credentials",
            ProviderError::RateLimited(_) => "rate_limited",
            ProviderError::Other(_) => "error",
        }
    }

    pub fn message(&self) -> String {
        match self {
            ProviderError::NoCredentials(m) | ProviderError::Other(m) => m.clone(),
            ProviderError::RateLimited(Some(d)) => {
                format!("Rate limited, retry after {}s", d.as_secs())
            }
            ProviderError::RateLimited(None) => "Rate limited".into(),
        }
    }
}

/// A source of stats. Each provider is polled on its own schedule and its
/// normalized JSON payload is emitted to the frontend as `stats://<id>`.
#[async_trait::async_trait]
pub trait StatProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn poll_interval(&self) -> Duration;
    async fn fetch(&self) -> Result<serde_json::Value, ProviderError>;
}

pub fn all() -> Vec<Box<dyn StatProvider>> {
    vec![Box::new(claude_usage::ClaudeUsageProvider::new())]
}
