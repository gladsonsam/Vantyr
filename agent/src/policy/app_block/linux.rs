//! Linux app blocking: scan `/proc` and send `SIGTERM` via `kill`.

use tracing::info;

use super::{BlockRule, KillEvent};

pub(super) fn scan_and_kill_matching_processes(
    rules: &[BlockRule],
    generation: crate::permissions::Generation,
) -> Vec<KillEvent> {
    let self_pid = std::process::id();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut killed = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        if !generation.valid() {
            break;
        }
        if pid == 0 || pid == 1 || pid == self_pid {
            continue;
        }
        let proc_dir = entry.path();
        let exe_path = std::fs::read_link(proc_dir.join("exe"))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let comm = std::fs::read_to_string(proc_dir.join("comm"))
            .unwrap_or_default()
            .trim()
            .to_string();
        let cmdline = std::fs::read(proc_dir.join("cmdline"))
            .ok()
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .replace('\0', " ")
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();

        let basename = exe_path
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(comm.as_str());
        let candidates = [exe_path.as_str(), basename, comm.as_str(), cmdline.as_str()];
        let Some(rule) = rules
            .iter()
            .find(|r| candidates.iter().any(|candidate| r.matches(candidate)))
        else {
            continue;
        };
        let candidate = candidates
            .iter()
            .find(|s| !s.trim().is_empty())
            .copied()
            .unwrap_or("unknown");
        if let Some(ev) = kill_pid(pid, rule, candidate, generation) {
            killed.push(ev);
        }
    }
    killed
}

fn kill_pid(
    pid: u32,
    rule: &BlockRule,
    candidate: &str,
    generation: crate::permissions::Generation,
) -> Option<KillEvent> {
    if !generation.valid() {
        return None;
    }
    if pid == 0 || pid == 1 || pid == std::process::id() {
        return None;
    }
    let status = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    info!(
        "App block: killed '{}' (pid {}) - rule #{}",
        candidate, pid, rule.id
    );
    Some(KillEvent {
        generation,
        rule_id: rule.id,
        rule_name: rule.exe_pattern.clone(),
        exe_name: candidate.to_string(),
    })
}
