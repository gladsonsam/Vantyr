//! Minimal operator CLI for the inspection CA.
//!
//! Secrets are always supplied as a path to an owner-only file, never as an
//! argument, an environment variable or a value printed by this program.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use time::OffsetDateTime;
use vantyr_network_pki::{
    check, export_public, init_ca, inspect_metadata, read_secret_file, rotate_ca, CaMetadata,
    PkiError, Result, RetirementRecord, VaultOptions, DEFAULT_CA_NAME,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("vantyr-network-ca: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().ok_or_else(|| {
        PkiError::InvalidName(
            "expected a command (init|export-public|check|inspect-metadata|rotate|recover)".into(),
        )
    })?;
    let flags = parse_flags(args)?;

    match command.as_str() {
        "init" => {
            let dir = require_dir(&flags)?;
            let secret = require_secret(&flags)?;
            let name = flag(&flags, "name").unwrap_or(DEFAULT_CA_NAME);
            let options = options_from(&flags)?;
            let metadata = init_ca(&dir, name, &secret, &options, OffsetDateTime::now_utc())?;
            print_metadata(&metadata)
        }
        "export-public" | "recover" => {
            let dir = require_dir(&flags)?;
            let secret = require_secret(&flags)?;
            let name = flag(&flags, "name").unwrap_or(DEFAULT_CA_NAME);
            let metadata = export_public(&dir, name, &secret)?;
            print_metadata(&metadata)
        }
        "check" => {
            let dir = require_dir(&flags)?;
            let secret = require_secret(&flags)?;
            let name = flag(&flags, "name").unwrap_or(DEFAULT_CA_NAME);
            let metadata = check(&dir, name, &secret)?;
            print_metadata(&metadata)
        }
        "inspect-metadata" => {
            let dir = require_dir(&flags)?;
            let name = flag(&flags, "name").unwrap_or(DEFAULT_CA_NAME);
            let path = dir.join(format!("{name}.public.json"));
            let metadata = inspect_metadata(&path)?;
            print_metadata(&metadata)
        }
        "rotate" => {
            let dir = require_dir(&flags)?;
            let old_secret = require_secret(&flags)?;
            let new_secret =
                read_secret_file(&PathBuf::from(require_flag(&flags, "new-secret-file")?))?;
            let old_name = flag(&flags, "old-name").unwrap_or(DEFAULT_CA_NAME);
            let new_name = require_flag(&flags, "new-name")?;
            let options = options_from(&flags)?;
            let (metadata, record) = rotate_ca(
                &dir,
                old_name,
                new_name,
                &old_secret,
                &new_secret,
                &options,
                OffsetDateTime::now_utc(),
            )?;
            print_rotation(&metadata, &record)
        }
        other => Err(PkiError::InvalidName(format!("unknown command {other:?}"))),
    }
}

fn parse_flags(args: impl Iterator<Item = String>) -> Result<HashMap<String, String>> {
    let mut flags = HashMap::new();
    let mut args = args;
    while let Some(item) = args.next() {
        let key = item
            .strip_prefix("--")
            .ok_or_else(|| PkiError::InvalidName(format!("expected a --flag, got {item:?}")))?;
        let value = args
            .next()
            .ok_or_else(|| PkiError::InvalidName(format!("missing value for --{key}")))?;
        flags.insert(key.to_owned(), value);
    }
    Ok(flags)
}

fn flag<'a>(flags: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    flags.get(key).map(String::as_str)
}

fn require_flag<'a>(flags: &'a HashMap<String, String>, key: &str) -> Result<&'a str> {
    flag(flags, key).ok_or_else(|| PkiError::InvalidName(format!("missing --{key}")))
}

fn require_dir(flags: &HashMap<String, String>) -> Result<PathBuf> {
    Ok(PathBuf::from(require_flag(flags, "dir")?))
}

fn require_secret(flags: &HashMap<String, String>) -> Result<secrecy::SecretString> {
    read_secret_file(Path::new(require_flag(flags, "secret-file")?))
}

fn options_from(flags: &HashMap<String, String>) -> Result<VaultOptions> {
    let mut options = VaultOptions::default();
    if let Some(days) = flag(flags, "valid-days") {
        options.ca_valid_days = days.parse().map_err(|_| PkiError::InvalidValidity)?;
    }
    if let Some(log_n) = flag(flags, "scrypt-log-n") {
        options.scrypt_log_n = log_n.parse().map_err(|_| PkiError::InvalidValidity)?;
    }
    options.validate()?;
    Ok(options)
}

fn print_metadata(metadata: &CaMetadata) -> Result<()> {
    let json = serde_json::to_string_pretty(metadata)?;
    println!("{json}");
    Ok(())
}

fn print_rotation(metadata: &CaMetadata, record: &RetirementRecord) -> Result<()> {
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "new_ca": metadata,
        "retirement": record,
    }))?;
    println!("{json}");
    Ok(())
}
