//! Linux power/session control.
//!
//! Lock works in a logind user session. Reboot/poweroff go through
//! `systemctl`, which requires normal system authorization (polkit) — run the
//! agent elevated, or configure a polkit rule, for these to succeed. They fail
//! closed with an error otherwise, and the capability block reports
//! `system_control: "limited"`.

pub fn lock_host() -> anyhow::Result<()> {
    let status = std::process::Command::new("loginctl")
        .arg("lock-session")
        .status()?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("loginctl lock-session exited with {status}")
    }
}

pub fn restart_host() -> anyhow::Result<()> {
    let status = std::process::Command::new("systemctl")
        .arg("reboot")
        .status()?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("systemctl reboot exited with {status} (needs privilege/polkit)")
    }
}

pub fn shutdown_host() -> anyhow::Result<()> {
    let status = std::process::Command::new("systemctl")
        .arg("poweroff")
        .status()?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("systemctl poweroff exited with {status} (needs privilege/polkit)")
    }
}
