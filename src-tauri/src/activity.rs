// Local "Claude Code is working" signal: Claude Code appends to a session log
// under `<config dir>/projects/<project>/*.jsonl` on every turn, so the newest
// write time says when it last did anything. Reads directory metadata only
// (no file contents, no network), cheap enough to poll every few seconds.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn projects_dir() -> Option<PathBuf> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()?.join(".claude"),
    };
    Some(base.join("projects"))
}

/// Newest modification time (unix ms) of any `.jsonl` log one level below
/// `projects`, or None if there are none.
fn newest_log_ms(projects: &Path) -> Option<u64> {
    let mut newest: Option<u64> = None;
    for project in std::fs::read_dir(projects).ok()?.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            if file.path().extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            newest = newest.max(modified);
        }
    }
    newest
}

pub fn latest_claude_activity_ms() -> Option<u64> {
    newest_log_ms(&projects_dir()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_projects(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dd-activity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_or_empty_projects_dir_has_no_activity() {
        assert_eq!(newest_log_ms(Path::new("does/not/exist")), None);
        let dir = temp_projects("empty");
        assert_eq!(newest_log_ms(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn finds_newest_jsonl_and_ignores_other_files() {
        let dir = temp_projects("newest");
        let proj = dir.join("proj-a");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("session.jsonl"), "{}").unwrap();
        std::fs::write(proj.join("notes.txt"), "x").unwrap();
        // A stray file directly under projects/ is not a project dir.
        std::fs::write(dir.join("stray.jsonl"), "{}").unwrap();

        let ms = newest_log_ms(&dir).expect("one log written");
        let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        assert!(now.saturating_sub(ms) < 60_000, "log mtime should be recent");
        let _ = std::fs::remove_dir_all(dir);
    }
}
