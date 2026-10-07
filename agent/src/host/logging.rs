//! Process-wide logging setup.

use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Registry};

/// `%ProgramData%\Vantyr\<filename>`: a stable, shared location for the logs of
/// the service and the processes it launches. `%ProgramData%` is writable for
/// LocalSystem and readable by admins.
#[cfg(windows)]
pub fn program_data_log_path(filename: &str) -> std::path::PathBuf {
    crate::config::program_data_vantyr_dir().join(filename)
}

/// Install the global `tracing` subscriber, writing to `AGENT_LOG_FILE`, else
/// `preferred_log_file`, else `agent.log` beside the config file.
pub fn init_logging(
    preferred_log_file: Option<std::path::PathBuf>,
) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    // In Windows release builds we run with `windows_subsystem = "windows"`,
    // so there is often no console attached. Write logs to a file by default
    // so failures are visible.
    //
    // Override path by setting `AGENT_LOG_FILE` to an absolute path.
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let mut log_file_path = std::env::var("AGENT_LOG_FILE")
        .ok()
        .map(std::path::PathBuf::from)
        .or(preferred_log_file);

    if log_file_path.is_none() {
        log_file_path = Some(crate::config::config_dir().join("agent.log"));
    }

    if let Some(path) = log_file_path {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let (writer, guard) = tracing_appender::non_blocking(file);
            let file_layer = fmt::layer()
                .with_target(false)
                .with_thread_ids(false)
                .compact()
                .with_writer(writer);
            Registry::default().with(env_filter).with(file_layer).init();
            Some(guard)
        } else {
            let stderr_layer = fmt::layer()
                .with_target(false)
                .with_thread_ids(false)
                .compact();
            Registry::default()
                .with(env_filter)
                .with(stderr_layer)
                .init();
            None
        }
    } else {
        let stderr_layer = fmt::layer()
            .with_target(false)
            .with_thread_ids(false)
            .compact();
        Registry::default()
            .with(env_filter)
            .with(stderr_layer)
            .init();
        None
    }
}
