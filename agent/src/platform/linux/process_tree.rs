//! Linux process-tree containment: kill the child's process group (or, for PTY
//! shells, its whole session) on drop.
//!
//! Lifecycle containment, not a privilege sandbox. Unix descendants that call
//! setsid escape their original group; unrestricted execution remains admin access.
pub struct ProcessTree {
    pid: u32,
    session: bool,
}
impl ProcessTree {
    pub fn attach(pid: u32) -> std::io::Result<Self> {
        Ok(Self {
            pid,
            session: false,
        })
    }
    pub fn attach_session(pid: u32) -> std::io::Result<Self> {
        Ok(Self { pid, session: true })
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // PTY shells create foreground job groups within their session. Kill
        // those groups too, rather than only the interactive shell's group.
        if self.session {
            if let Ok(entries) = std::fs::read_dir("/proc") {
                for entry in entries.flatten() {
                    let Some(pid) = entry
                        .file_name()
                        .to_str()
                        .and_then(|s| s.parse::<i32>().ok())
                    else {
                        continue;
                    };
                    unsafe {
                        if libc::getsid(pid) == self.pid as i32 && pid != self.pid as i32 {
                            libc::kill(pid, libc::SIGKILL);
                        }
                    }
                }
            }
        }
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
    }
}
