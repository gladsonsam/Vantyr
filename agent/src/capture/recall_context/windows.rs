use super::{Reason, Snapshot, Source};
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, LPARAM, WPARAM},
        System::{
            StationsAndDesktops::{GetThreadDesktop, GetUserObjectInformationW, UOI_NAME},
            Threading::{
                GetCurrentThreadId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
                PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, SendMessageTimeoutW, SMTO_ABORTIFHUNG,
            SMTO_BLOCK, SMTO_ERRORONEXIT, WM_GETTEXT,
        },
    },
};

pub(super) fn snapshot() -> Result<Snapshot, Reason> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Err(Reason::NoForeground);
        }
        let desktop = GetThreadDesktop(GetCurrentThreadId()).map_err(|_| Reason::ReadFailed)?;
        let mut name = [0u16; 256];
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * 2) as u32,
            None,
        )
        .map_err(|_| Reason::ReadFailed)?;
        let desktop_name = String::from_utf16_lossy(
            &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
        );
        // Recall companion observes its own desktop only; don't attribute Winlogon to Default.
        if !desktop_name.eq_ignore_ascii_case("default") {
            return Err(Reason::Unsupported);
        }
        let mut pid = 0;
        let thread = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        // SendMessageTimeout does not enforce its timeout for the calling thread's queue.
        if thread == GetCurrentThreadId() {
            return Err(Reason::Unsupported);
        }
        if pid == 0 {
            return Err(Reason::IdentityUnverified);
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|_| Reason::ReadFailed)?;
        struct Process(HANDLE);
        impl Drop for Process {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let process = Process(handle);
        let mut created = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user)
            .map_err(|_| Reason::ReadFailed)?;
        let mut path = [0u16; 2048];
        let mut size = path.len() as u32;
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut size,
        )
        .map_err(|_| Reason::ReadFailed)?;
        let path = String::from_utf16_lossy(&path[..size as usize]);
        let app = path.rsplit(['\\', '/']).next().unwrap_or("").to_owned();
        // WM_GETTEXT with a real bounded OS call, never an unbounded same-process GetWindowText.
        let mut title = [0u16; 1025];
        let mut result = 0usize;
        if SendMessageTimeoutW(
            hwnd,
            WM_GETTEXT,
            WPARAM(title.len()),
            LPARAM(title.as_mut_ptr() as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
            25,
            Some(&mut result),
        )
        .0 == 0
        {
            return Err(Reason::SampleTimeout);
        }
        if GetForegroundWindow() != hwnd {
            return Err(Reason::Changed);
        }
        let count = result.min(title.len() - 1);
        Ok(Snapshot {
            identity: format!(
                "{desktop_name}:{:?}:{pid}:{}:{}",
                hwnd.0, created.dwHighDateTime, created.dwLowDateTime
            ),
            app,
            title: String::from_utf16_lossy(&title[..count]),
            source: Source::Win32,
            title_truncated: count == title.len() - 1,
        })
    }
}
