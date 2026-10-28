use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// User-arranged card layout: card ids top to bottom, and which are collapsed
/// to their title row.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Layout {
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub collapsed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    pub total_credit: Option<f64>,
    pub monthly_budget: Option<f64>,
    #[serde(default)]
    pub layout: Layout,
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, settings: &Settings) {
    if let Some(path) = settings_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            let _ = std::fs::write(path, json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_saved_before_layout_existed_still_load() {
        let s: Settings =
            serde_json::from_str(r#"{"window_x":10,"window_y":20,"monthly_budget":300.0}"#).unwrap();
        assert_eq!(s.window_x, Some(10));
        assert!(s.layout.order.is_empty() && s.layout.collapsed.is_empty());
    }

    #[test]
    fn layout_tolerates_missing_fields() {
        let l: Layout = serde_json::from_str(r#"{"order":["a","b"]}"#).unwrap();
        assert_eq!(l.order, ["a", "b"]);
        assert!(l.collapsed.is_empty());
    }
}
