use super::{Reason, Snapshot, Source};
use std::{
    io::Read,
    os::unix::{io::AsRawFd, process::CommandExt},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

// No detached timeout thread: own, bound, kill and reap the helper/process group.
fn bounded_output(command: &mut Command, budget: Duration) -> Result<Vec<u8>, Reason> {
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|_| Reason::ReadFailed)?;
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedChild(child);
    let mut stdout = child.0.stdout.take().ok_or(Reason::ReadFailed)?;
    let fd = stdout.as_raw_fd();
    if unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        return Err(Reason::ReadFailed);
    }
    let start = Instant::now();
    let mut out = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        if start.elapsed() >= budget {
            return Err(Reason::SampleTimeout);
        }
        match stdout.read(&mut chunk) {
            Ok(0) => {
                if let Some(status) = child.0.try_wait().map_err(|_| Reason::ReadFailed)? {
                    return if status.success() {
                        Ok(out)
                    } else {
                        Err(Reason::ReadFailed)
                    };
                }
            }
            Ok(n) => {
                if out.len() + n > 32 * 1024 {
                    return Err(Reason::ReadFailed);
                }
                out.extend_from_slice(&chunk[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return Err(Reason::ReadFailed),
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn parse(bytes: &[u8], session: &str) -> Result<Snapshot, Reason> {
    let v: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| Reason::ReadFailed)?;
    let address = v["address"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "0x0")
        .ok_or(Reason::NoForeground)?;
    let pid = v["pid"]
        .as_u64()
        .filter(|p| *p > 0)
        .ok_or(Reason::IdentityUnverified)?;
    let app = v["class"].as_str().ok_or(Reason::ReadFailed)?.to_owned();
    let title = v["title"].as_str().ok_or(Reason::ReadFailed)?.to_owned();
    Ok(Snapshot {
        identity: format!("{session}:{address}:{pid}"),
        app,
        title,
        source: Source::Hyprland,
        title_truncated: false,
    })
}
pub(super) fn snapshot() -> Result<Snapshot, Reason> {
    let session = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").map_err(|_| Reason::Unsupported)?;
    if session.is_empty() || session.len() > 256 {
        return Err(Reason::Unsupported);
    }
    // Keep subprocess/query work off telemetry caches. Fixed helper path, bounded output.
    let out = bounded_output(
        Command::new("/usr/bin/hyprctl").args(["-j", "activewindow"]),
        Duration::from_millis(75),
    )?;
    parse(&out, &session)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_window_identity_is_not_pid_or_title() {
        let a = parse(
            br#"{"address":"0x123","pid":2,"class":"editor","title":"same"}"#,
            "seat",
        )
        .unwrap();
        let b = parse(
            br#"{"address":"0x456","pid":2,"class":"editor","title":"same"}"#,
            "seat",
        )
        .unwrap();
        assert_ne!(a.identity, b.identity);
        assert_eq!(a.app, b.app);
        assert_eq!(parse(b"{}", "seat").unwrap_err(), Reason::NoForeground);
    }
    #[test]
    fn helpers_are_bounded_reaped_and_output_capped() {
        let start = Instant::now();
        assert_eq!(
            bounded_output(
                Command::new("/bin/sh").args(["-c", "sleep 2"]),
                Duration::from_millis(30)
            )
            .unwrap_err(),
            Reason::SampleTimeout
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(
            bounded_output(
                Command::new("/bin/sh").args(["-c", "yes x"]),
                Duration::from_millis(200)
            )
            .unwrap_err(),
            Reason::ReadFailed
        );
        assert_eq!(
            bounded_output(
                Command::new("/bin/sh").args(["-c", "printf '{}' "]),
                Duration::from_millis(200)
            )
            .unwrap(),
            b"{}"
        );
    }
}
