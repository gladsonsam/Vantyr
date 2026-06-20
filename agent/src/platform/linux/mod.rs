//! Linux platform backend.
//!
//! Linux desktop integration is intentionally capability-driven. Features that
//! need compositor support, portal consent, or elevated privileges fail closed
//! when the current session cannot provide them.

pub mod activity_tracker {
    use serde_json::Value;

    #[derive(Debug, Clone)]
    pub struct WindowEvent {
        pub title: String,
        pub app: String,
        pub app_display: String,
        pub app_path: String,
        pub hwnd: usize,
    }

    #[derive(Default)]
    pub struct WindowTracker {
        last_key: String,
    }

    impl WindowTracker {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn poll(&mut self) -> Option<WindowEvent> {
            if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
                return self.poll_hyprland();
            }
            None
        }

        fn poll_hyprland(&mut self) -> Option<WindowEvent> {
            let output = std::process::Command::new("hyprctl")
                .args(["-j", "activewindow"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let value: Value = serde_json::from_slice(&output.stdout).ok()?;
            let title = value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let class = value
                .get("class")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let pid = value.get("pid").and_then(Value::as_u64).unwrap_or(0);
            let app_path = if pid > 0 {
                std::fs::read_link(format!("/proc/{pid}/exe"))
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let app = if !app_path.is_empty() {
                app_path
                    .rsplit('/')
                    .next()
                    .unwrap_or(class.as_str())
                    .to_string()
            } else {
                class.clone()
            };
            let key = format!("{pid}\n{title}\n{app_path}");
            if key == self.last_key {
                return None;
            }
            self.last_key = key;
            Some(WindowEvent {
                title,
                app_display: if class.is_empty() { app.clone() } else { class },
                app,
                app_path,
                hwnd: pid as usize,
            })
        }
    }

    pub fn app_icon_png_for_path(_path: &str, _size: u32) -> anyhow::Result<Vec<u8>> {
        anyhow::bail!("app icon extraction is not implemented on Linux")
    }
}

pub mod config_store {
    pub use crate::config::{
        config_path, load_config, save_config, take_reopen_settings_ui_after_restart, Config,
    };
}

pub mod desktop_capture {
    pub use crate::capture::{start_capture, CaptureSettings};
}

pub mod input_control {
    pub use crate::input::InputController;
}

pub mod keyboard_monitor {
    #[derive(Debug, Clone)]
    pub enum InputEvent {
        Keys {
            text: String,
            app: String,
            app_display: String,
            window: String,
            ts: u64,
        },
        Afk {
            idle_secs: u64,
        },
        Active,
    }

    pub fn start(_out_tx: tokio::sync::mpsc::Sender<InputEvent>) -> anyhow::Result<()> {
        tracing::warn!(
            "Keyboard monitoring is not implemented on Linux; continuing without keys/AFK events."
        );
        Ok(())
    }
}

pub mod network_policy {
    pub use crate::network_policy::{apply_block, parse_server_host_port, remove_block};
}

pub mod script_execution {
    pub use crate::remote_script::{run, RunOutcome};
}

pub mod software_inventory {
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

    pub use crate::software_inventory::cmp_str_ascii_case_insensitive;

    fn run_command(program: &str, args: &[&str]) -> Option<String> {
        let output = std::process::Command::new(program)
            .args(args)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn collect_items() -> Vec<serde_json::Value> {
        let mut items = Vec::new();

        if let Some(out) = run_command("pacman", &["-Q"]) {
            for line in out.lines().take(8000) {
                let mut parts = line.splitn(2, ' ');
                let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let version = parts.next().unwrap_or("").trim();
                items.push(serde_json::json!({
                    "name": name,
                    "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                    "publisher": "pacman",
                    "install_location": serde_json::Value::Null,
                    "install_date": serde_json::Value::Null,
                }));
            }
        }

        if let Some(out) = run_command("dpkg-query", &["-W", "-f=${Package}\t${Version}\n"]) {
            for line in out.lines().take(8000) {
                let mut parts = line.splitn(2, '\t');
                let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let version = parts.next().unwrap_or("").trim();
                items.push(serde_json::json!({
                    "name": name,
                    "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                    "publisher": "dpkg",
                    "install_location": serde_json::Value::Null,
                    "install_date": serde_json::Value::Null,
                }));
            }
        }

        if let Some(out) = run_command("rpm", &["-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"])
        {
            for line in out.lines().take(8000) {
                let mut parts = line.splitn(2, '\t');
                let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let version = parts.next().unwrap_or("").trim();
                items.push(serde_json::json!({
                    "name": name,
                    "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                    "publisher": "rpm",
                    "install_location": serde_json::Value::Null,
                    "install_date": serde_json::Value::Null,
                }));
            }
        }

        if let Some(out) = run_command(
            "flatpak",
            &["list", "--app", "--columns=application,version"],
        ) {
            for line in out.lines().take(8000) {
                let mut parts = line.splitn(2, '\t');
                let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let version = parts.next().unwrap_or("").trim();
                items.push(serde_json::json!({
                    "name": name,
                    "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                    "publisher": "flatpak",
                    "install_location": serde_json::Value::Null,
                    "install_date": serde_json::Value::Null,
                }));
            }
        }

        items.sort_by(|a, b| {
            let na = a["name"].as_str().unwrap_or("");
            let nb = b["name"].as_str().unwrap_or("");
            cmp_str_ascii_case_insensitive(na, nb)
        });
        items.truncate(8000);
        items
    }

    fn fingerprint_items(items: &[serde_json::Value]) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        items.len().hash(&mut h);
        for item in items {
            item["name"].as_str().unwrap_or("").hash(&mut h);
            item["version"].as_str().unwrap_or("").hash(&mut h);
            item["publisher"].as_str().unwrap_or("").hash(&mut h);
        }
        h.finish()
    }

    pub async fn send_inventory(out_tx: mpsc::Sender<Message>) {
        let items = tokio::task::spawn_blocking(collect_items)
            .await
            .unwrap_or_default();
        let payload = serde_json::json!({
            "type": "software_inventory",
            "items": items,
            "captured_at": crate::unix_timestamp_secs(),
        })
        .to_string();
        let _ = out_tx.send(Message::Text(payload)).await;
    }

    pub async fn send_inventory_if_changed(
        out_tx: mpsc::Sender<Message>,
        last_fingerprint: &tokio::sync::Mutex<Option<u64>>,
    ) {
        let items = tokio::task::spawn_blocking(collect_items)
            .await
            .unwrap_or_default();
        let fp = fingerprint_items(&items);
        let mut guard = last_fingerprint.lock().await;
        if guard.as_ref() == Some(&fp) {
            return;
        }
        *guard = Some(fp);
        drop(guard);
        let payload = serde_json::json!({
            "type": "software_inventory",
            "items": items,
            "captured_at": crate::unix_timestamp_secs(),
        })
        .to_string();
        let _ = out_tx.send(Message::Text(payload)).await;
    }
}

pub mod system_control {
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
            anyhow::bail!("systemctl reboot exited with {status}")
        }
    }

    pub fn shutdown_host() -> anyhow::Result<()> {
        let status = std::process::Command::new("systemctl")
            .arg("poweroff")
            .status()?;
        if status.success() {
            Ok(())
        } else {
            anyhow::bail!("systemctl poweroff exited with {status}")
        }
    }
}

pub mod system_info {
    pub use crate::system_info::{
        active_username, collect_agent_info, collect_resource_metrics, env_username_fallback,
    };
}

pub mod terminal {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::sync::{Mutex, OnceLock};

    use base64::Engine;
    use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;
    use uuid::Uuid;

    struct Session {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
    }

    fn registry() -> &'static Mutex<HashMap<Uuid, Session>> {
        static REGISTRY: OnceLock<Mutex<HashMap<Uuid, Session>>> = OnceLock::new();
        REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn exit_frame(session_id: Uuid) -> Message {
        Message::Text(
            serde_json::json!({ "type": "terminal_exit", "session_id": session_id }).to_string(),
        )
    }

    pub fn start(session_id: Uuid, _cols: u16, _rows: u16, out_tx: mpsc::Sender<Message>) {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: _rows.max(1),
            cols: _cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = match pty_system.openpty(size) {
            Ok(pair) => pair,
            Err(e) => {
                tracing::warn!("terminal: openpty failed: {e}");
                let _ = out_tx.try_send(exit_frame(session_id));
                return;
            }
        };
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".into());
        let cmd = CommandBuilder::new(shell);
        let child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => {
                tracing::warn!("terminal: spawn shell failed: {e}");
                let _ = out_tx.try_send(exit_frame(session_id));
                return;
            }
        };
        drop(pair.slave);
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(e) => {
                tracing::warn!("terminal: clone reader failed: {e}");
                let _ = out_tx.try_send(exit_frame(session_id));
                return;
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(e) => {
                tracing::warn!("terminal: take writer failed: {e}");
                let _ = out_tx.try_send(exit_frame(session_id));
                return;
            }
        };

        registry().lock().unwrap_or_else(|e| e.into_inner()).insert(
            session_id,
            Session {
                master: pair.master,
                writer,
                child,
            },
        );

        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data_b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let frame = serde_json::json!({
                            "type": "terminal_output",
                            "session_id": session_id,
                            "data_b64": data_b64,
                        })
                        .to_string();
                        if out_tx.blocking_send(Message::Text(frame)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = out_tx.blocking_send(exit_frame(session_id));
            close(session_id);
        });
    }

    pub fn input(session_id: Uuid, data: &str) {
        if let Some(session) = registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&session_id)
        {
            let _ = session.writer.write_all(data.as_bytes());
            let _ = session.writer.flush();
        }
    }

    pub fn resize(session_id: Uuid, cols: u16, rows: u16) {
        if let Some(session) = registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&session_id)
        {
            let size = PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            };
            if let Err(e) = session.master.resize(size) {
                tracing::warn!("terminal: resize failed for {session_id}: {e}");
            }
        }
    }

    pub fn close(session_id: Uuid) {
        if let Some(mut session) = registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&session_id)
        {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}

pub mod url_provider {
    #[derive(Debug, Clone)]
    pub struct ActiveUrl {
        pub url: String,
        pub title: String,
        pub browser_name: String,
    }

    pub fn active_url() -> Option<ActiveUrl> {
        None
    }
}
