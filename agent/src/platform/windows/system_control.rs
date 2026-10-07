//! Windows power/session control: lock, restart and shut down the host.

use anyhow::{anyhow, Result};
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn run_hidden(program: &str, args: &[&str]) -> Result<()> {
    let status = std::process::Command::new(program)
        .creation_flags(CREATE_NO_WINDOW)
        .args(args)
        .status()
        .map_err(|e| anyhow!("failed to execute {program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("{program} exited with status {status}"))
    }
}

pub fn lock_host() -> Result<()> {
    run_hidden("rundll32.exe", &["user32.dll,LockWorkStation"])
}

pub fn restart_host() -> Result<()> {
    run_hidden("shutdown", &["/r", "/t", "0", "/f"])
}

pub fn shutdown_host() -> Result<()> {
    run_hidden("shutdown", &["/s", "/t", "0", "/f"])
}
