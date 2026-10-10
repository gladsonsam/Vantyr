//! The command line: which role this process plays and the options it was given.

use std::path::PathBuf;

/// The parsed command line. Role flags specific to one OS (e.g. `--service`)
/// are read by that OS's host backend; elsewhere they are ignored.
pub struct Launch {
    args: Vec<String>,
}

impl Launch {
    pub fn from_args(args: Vec<String>) -> Self {
        Self { args }
    }

    /// Whether the bare flag `name` (e.g. `--no-ui`) was given.
    pub fn flag(&self, name: &str) -> bool {
        self.args.iter().any(|a| a == name)
    }

    /// `vantyr-agent --module-permission [module on|off]` (must be the first
    /// argument): the arguments after it.
    pub fn module_permission(&self) -> Option<&[String]> {
        self.args
            .get(1)
            .is_some_and(|a| a == "--module-permission")
            .then(|| &self.args[2..])
    }

    /// `vantyr-agent --import-machine-config <agent.json>`.
    /// Windows writes `%ProgramData%\Vantyr\config.dat` with DPAPI machine scope;
    /// Linux writes the per-user XDG config JSON.
    pub fn import_machine_config(&self) -> Option<PathBuf> {
        let args = &self.args;
        if let Some(i) = args.iter().position(|a| a == "--import-machine-config") {
            if let Some(p) = args.get(i + 1) {
                let p = p.trim_matches('"').trim();
                if !p.is_empty() {
                    return Some(PathBuf::from(p));
                }
            }
            return None;
        }
        if let Some(a) = args
            .iter()
            .find(|a| a.starts_with("--import-machine-config="))
        {
            let p = a
                .trim_start_matches("--import-machine-config=")
                .trim_matches('"')
                .trim();
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
        None
    }

    pub fn log_file(&self) -> Option<PathBuf> {
        let args = &self.args;
        // Optional CLI override (used by the Windows launcher service so we can always find logs).
        if let Some(i) = args.iter().position(|a| a == "--log-file") {
            if let Some(p) = args.get(i + 1) {
                let p = p.trim_matches('"').trim();
                if !p.is_empty() {
                    return Some(PathBuf::from(p));
                }
            }
            return None;
        }
        if let Some(a) = args.iter().find(|a| a.starts_with("--log-file=")) {
            let p = a.trim_start_matches("--log-file=").trim_matches('"').trim();
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
        None
    }

    /// Allow disabling the UI entirely (headless mode). Useful when running the
    /// agent as a scheduled task / service where a window surface cannot be created.
    pub fn no_ui(&self) -> bool {
        self.flag("--no-ui") || env_flag("AGENT_NO_UI")
    }
}

/// `1`/`true`/`yes`/`on` (any of the usual casings) in environment variable `name`.
pub fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| {
            matches!(
                v.trim(),
                "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
            )
        })
        .unwrap_or(false)
}
