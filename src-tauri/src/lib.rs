mod providers;
mod state;

use providers::ProviderError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Listener, Manager, PhysicalPosition};
use tokio::sync::Notify;

const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);
const ERROR_BACKOFF_START: Duration = Duration::from_secs(60);

/// Shared app state: latest payload per provider and manual-refresh triggers.
struct Dashboard {
    latest: Mutex<HashMap<String, Value>>,
    refresh: Mutex<HashMap<String, Arc<Notify>>>,
}

fn event_name(provider_id: &str) -> String {
    format!("stats://{provider_id}")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Runs one provider's poll loop forever, emitting normalized payloads.
async fn run_provider(app: tauri::AppHandle, provider: Box<dyn providers::StatProvider>, notify: Arc<Notify>) {
    let interval = provider.poll_interval();
    let mut backoff = ERROR_BACKOFF_START;
    loop {
        let result = provider.fetch().await;
        if let Err(e) = &result {
            eprintln!("[{}] fetch error: {} ({})", provider.id(), e.message(), e.kind());
        }
        let delay = match &result {
            Ok(_) => {
                backoff = ERROR_BACKOFF_START;
                interval
            }
            Err(ProviderError::RateLimited(retry_after)) => {
                let d = retry_after.unwrap_or(backoff).max(backoff);
                backoff = (backoff * 2).min(MAX_BACKOFF);
                d.min(MAX_BACKOFF)
            }
            Err(ProviderError::NoCredentials(_)) => interval,
            Err(ProviderError::Other(_)) => {
                let d = backoff;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                d
            }
        };

        let payload = match result {
            Ok(data) => json!({
                "ok": true,
                "data": data,
                "fetched_at": now_ms(),
                "next_poll_secs": delay.as_secs(),
            }),
            Err(e) => json!({
                "ok": false,
                "error": {"kind": e.kind(), "message": e.message()},
                "fetched_at": now_ms(),
                "next_poll_secs": delay.as_secs(),
            }),
        };

        if let Some(state) = app.try_state::<Dashboard>() {
            state
                .latest
                .lock()
                .unwrap()
                .insert(provider.id().to_string(), payload.clone());
        }
        let _ = app.emit(&event_name(provider.id()), payload);

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = notify.notified() => { backoff = ERROR_BACKOFF_START; }
        }
    }
}

/// Returns the last payload for a provider (so the frontend can render
/// immediately without waiting for the next poll event).
#[tauri::command]
fn get_stats(state: tauri::State<Dashboard>, provider_id: String) -> Option<Value> {
    state.latest.lock().unwrap().get(&provider_id).cloned()
}

/// Triggers an immediate re-poll of one provider (or all, if none given).
#[tauri::command]
fn refresh_now(state: tauri::State<Dashboard>, provider_id: Option<String>) {
    let map = state.refresh.lock().unwrap();
    match provider_id {
        Some(id) => {
            if let Some(n) = map.get(&id) {
                n.notify_one();
            }
        }
        None => {
            for n in map.values() {
                n.notify_one();
            }
        }
    }
}

#[tauri::command]
fn resize_window(app: tauri::AppHandle, height: f64) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_size(tauri::LogicalSize::new(340.0, height.max(80.0)));
    }
}

#[tauri::command]
fn get_budget(app: tauri::AppHandle) -> Option<f64> {
    state::load(&app).monthly_budget
}

#[tauri::command]
fn set_budget(app: tauri::AppHandle, budget: Option<f64>) {
    let mut settings = state::load(&app);
    settings.monthly_budget = budget;
    state::save(&app, &settings);
}

#[tauri::command]
fn get_layout(app: tauri::AppHandle) -> state::Layout {
    state::load(&app).layout
}

#[tauri::command]
fn set_layout(app: tauri::AppHandle, layout: state::Layout) {
    let mut settings = state::load(&app);
    settings.layout = layout;
    state::save(&app, &settings);
}

fn restore_position(app: &tauri::AppHandle) {
    let settings = state::load(app);
    if let (Some(x), Some(y)) = (settings.window_x, settings.window_y) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Saves window position, debounced so dragging doesn't hammer the disk.
fn watch_position(app: &tauri::AppHandle) {
    let win = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };
    let generation = Arc::new(AtomicU64::new(0));
    let app_handle = app.clone();
    let zoom_win = win.clone();
    win.on_window_event(move |event| {
        // WebView2 can silently multiply its zoom factor on monitor DPI/scale
        // events (display sleep/wake, docking); pin it back to 1.0.
        if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
            let _ = zoom_win.set_zoom(1.0);
        }
        if let tauri::WindowEvent::Moved(pos) = event {
            let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
            let generation = generation.clone();
            let app_handle = app_handle.clone();
            let (x, y) = (pos.x, pos.y);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(800)).await;
                if generation.load(Ordering::SeqCst) == my_gen {
                    let mut settings = state::load(&app_handle);
                    settings.window_x = Some(x);
                    settings.window_y = Some(y);
                    state::save(&app_handle, &settings);
                }
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Dashboard {
            latest: Mutex::new(HashMap::new()),
            refresh: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_stats,
            refresh_now,
            resize_window,
            get_budget,
            set_budget,
            get_layout,
            set_layout
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            restore_position(&handle);
            watch_position(&handle);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                // Watchdog: WebView2 sometimes drifts its zoom factor on DPI
                // events that never reach us as ScaleFactorChanged.
                let zoom_win = win.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let _ = zoom_win.set_zoom(1.0);
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    }
                });
            }

            for provider in providers::all() {
                let notify = Arc::new(Notify::new());
                app.state::<Dashboard>()
                    .refresh
                    .lock()
                    .unwrap()
                    .insert(provider.id().to_string(), notify.clone());
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(run_provider(app_handle, provider, notify));
            }

            // Frontend signals readiness; re-emit cached payloads it may have missed.
            let handle = app.handle().clone();
            app.listen("frontend-ready", move |_| {
                if let Some(state) = handle.try_state::<Dashboard>() {
                    for (id, payload) in state.latest.lock().unwrap().iter() {
                        let _ = handle.emit(&event_name(id), payload.clone());
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
