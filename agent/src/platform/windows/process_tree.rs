//! Windows process-tree containment: a kill-on-close job object.
//!
//! Lifecycle containment, not a privilege sandbox; unrestricted execution
//! remains admin access.
pub struct ProcessTree {
    job: windows::Win32::Foundation::HANDLE,
}
unsafe impl Send for ProcessTree {}
unsafe impl Sync for ProcessTree {}
impl ProcessTree {
    /// Caller must spawn suspended so no child can run before job assignment.
    pub fn attach(pid: u32) -> std::io::Result<Self> {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null())
                .map_err(std::io::Error::other)?;
            let tree = Self { job };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(std::io::Error::other)?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(std::io::Error::other)?;
            let result = AssignProcessToJobObject(job, process);
            let _ = CloseHandle(process);
            result.map_err(std::io::Error::other)?;
            Ok(tree)
        }
    }
    pub fn resume(pid: u32) -> std::io::Result<()> {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{Diagnostics::ToolHelp::*, Threading::*},
        };
        unsafe {
            let snapshot =
                CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(std::io::Error::other)?;
            let result = (|| {
                let mut entry = THREADENTRY32 {
                    dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                    ..Default::default()
                };
                Thread32First(snapshot, &mut entry).map_err(std::io::Error::other)?;
                loop {
                    if entry.th32OwnerProcessID == pid {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                            .map_err(std::io::Error::other)?;
                        let count = ResumeThread(thread);
                        let _ = CloseHandle(thread);
                        if count == u32::MAX {
                            return Err(std::io::Error::last_os_error());
                        }
                        return Ok(());
                    }
                    if Thread32Next(snapshot, &mut entry).is_err() {
                        return Err(std::io::Error::other("suspended child thread not found"));
                    }
                }
            })();
            let _ = CloseHandle(snapshot);
            result
        }
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.job);
        }
    }
}
