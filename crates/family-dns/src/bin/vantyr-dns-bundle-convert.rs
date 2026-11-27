//! Explicit offline conversion of one prior-shape DNS bundle file.
//!
//!   vantyr-dns-bundle-convert --check <state-file>
//!   vantyr-dns-bundle-convert --apply <state-file>
//!
//! `--check` is a read-only dry run. `--apply` writes only after every prior
//! digest check and strict current-bundle check has passed, keeping the exact
//! original bytes in a sibling backup. There is no implicit conversion in the
//! worker and no runtime compatibility reader.

use std::path::PathBuf;
use std::process::ExitCode;

use vantyr_dns::bundle_convert::{apply_file, check_file};

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next();
    let path = args.next();
    let extra = args.next();

    let mode = match mode.as_deref().and_then(|value| value.to_str()) {
        Some("--check") => "--check",
        Some("--apply") => "--apply",
        _ => {
            eprintln!("usage: vantyr-dns-bundle-convert (--check | --apply) <state-file>");
            return ExitCode::from(2);
        }
    };
    let Some(path) = path else {
        eprintln!("usage: vantyr-dns-bundle-convert (--check | --apply) <state-file>");
        return ExitCode::from(2);
    };
    if extra.is_some() {
        eprintln!("usage: vantyr-dns-bundle-convert (--check | --apply) <state-file>");
        return ExitCode::from(2);
    }

    let path = PathBuf::from(path);
    let result = if mode == "--check" {
        check_file(&path)
    } else {
        apply_file(&path)
    };
    match result {
        Ok(converted) => {
            println!(
                "{}: prior schema {} at applied version {} converts to a strict current bundle",
                mode, converted.source_schema, converted.source_config_version
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("conversion refused: {error}");
            ExitCode::FAILURE
        }
    }
}
