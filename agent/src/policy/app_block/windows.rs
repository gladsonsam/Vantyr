//! Windows app blocking: Toolhelp process snapshot + `TerminateProcess`.

use tracing::{info, warn};

use super::{BlockRule, KillEvent};

pub(super) fn scan_and_kill_matching_processes(
    rules: &[BlockRule],
    generation: crate::permissions::Generation,
) -> Vec<KillEvent> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let snap = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(h) => h,
        Err(e) => {
            warn!("App block: CreateToolhelp32Snapshot failed: {e}");
            return Vec::new();
        }
    };

    if !generation.valid() {
        let _ = unsafe { CloseHandle(snap) };
        return Vec::new();
    }
    let self_pid = unsafe { GetCurrentProcessId() };
    let mut killed = Vec::new();

    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    let mut result = unsafe { Process32FirstW(snap, &raw mut entry) };
    while result.is_ok() {
        let len = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
        let pid = entry.th32ProcessID;

        if pid != self_pid && pid != 0 && pid != 4 {
            let image_path = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
                .ok()
                .and_then(|h| {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as u32;
                    let r = unsafe {
                        QueryFullProcessImageNameW(
                            h,
                            PROCESS_NAME_FORMAT(0),
                            PWSTR(buf.as_mut_ptr()),
                            &raw mut size,
                        )
                    };
                    let _ = unsafe { CloseHandle(h) };
                    r.ok()
                        .map(|()| String::from_utf16_lossy(&buf[..size as usize]))
                });
            let candidate = image_path.clone().unwrap_or_else(|| exe.clone());
            if let Some(rule) = rules.iter().find(|r| r.matches(&candidate)) {
                if let Some(kill) = kill_pid(pid, rule, &candidate, generation) {
                    killed.push(kill);
                }
            }
        }

        result = unsafe { Process32NextW(snap, &raw mut entry) };
    }

    let _ = unsafe { CloseHandle(snap) };
    killed
}

fn kill_pid(
    pid: u32,
    rule: &BlockRule,
    candidate: &str,
    generation: crate::permissions::Generation,
) -> Option<KillEvent> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };

    if !generation.valid() {
        return None;
    }
    let self_pid = unsafe { GetCurrentProcessId() };
    if pid == 0 || pid == 4 || pid == self_pid {
        return None;
    }

    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }.ok()?;
    let ok = unsafe { TerminateProcess(handle, 1) }.is_ok();
    let _ = unsafe { CloseHandle(handle) };
    if !ok {
        return None;
    }

    info!(
        "App block: killed '{}' (pid {}) — rule #{}",
        candidate, pid, rule.id
    );
    Some(KillEvent {
        generation,
        rule_id: rule.id,
        rule_name: rule.exe_pattern.clone(),
        exe_name: candidate.to_string(),
    })
}
