//! The process host: parse the command line, pick this process's role and
//! start it. Also the Windows plumbing around those roles — the Session 0
//! service, the IPC pipes between service and companion, the client for the
//! privileged service pipe and the settings UI — plus the agent's own log files.

mod agent;
#[cfg(windows)]
pub mod ipc;
mod launch;
pub mod log_sources;
pub mod logging;
pub mod role;
#[cfg(windows)]
pub mod service;
#[cfg(windows)]
pub mod service_client;
#[cfg(windows)]
pub mod single_instance;
#[cfg(windows)]
pub mod ui;

// Which roles exist and how the UI runs differ per OS.
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

pub use launch::Launch;

/// Run the process in the role `launch` asks for.
pub fn run(launch: Launch) {
    if let Some(args) = launch.module_permission() {
        module_permission_cli(args);
        return;
    }
    if let Some(json_path) = launch.import_machine_config() {
        import_machine_config_cli(&json_path);
    }
    if imp::run_service_role(&launch) {
        return;
    }
    agent::run(&launch);
}

/// `--module-permission`: print the module grants, or set one (`module on|off`).
fn module_permission_cli(args: &[String]) {
    let result = (|| -> anyhow::Result<()> {
        if args.is_empty() {
            println!("{}", crate::permissions::load()?.wire());
            return Ok(());
        }
        anyhow::ensure!(
            args.len() == 2,
            "usage: --module-permission [module on|off]"
        );
        let module = serde_json::from_value(serde_json::Value::String(args[0].clone()))?;
        let enabled = match args[1].as_str() {
            "on" => true,
            "off" => false,
            _ => anyhow::bail!("use on or off"),
        };
        println!("{}", crate::permissions::local_set(module, enabled)?.wire());
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}

/// `--import-machine-config`: write the config from a JSON file and exit.
fn import_machine_config_cli(json_path: &std::path::Path) -> ! {
    eprintln!("Importing agent config from {} ...", json_path.display());
    match crate::config::import_machine_config_from_json_file(json_path) {
        Ok(()) => eprintln!("Wrote {}.", crate::config::imported_location()),
        Err(e) => {
            eprintln!("Import failed: {e:#}");
            std::process::exit(1);
        }
    }
    std::process::exit(0);
}
