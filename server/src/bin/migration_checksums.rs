//! Emit `UPDATE _sqlx_migrations ...` statements using the same resolution + SHA-384
//! logic as `SQLx` (matches `sqlx::migrate!()` at compile time when run on the same files).
//!
//! From repo root: `cargo run --locked -p vantyr-server --bin migration_checksums`
//! (uses `server/migrations` by default).

use sqlx::migrate::Migrator;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let default = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let path = std::env::args().nth(1).map_or(default, PathBuf::from);
    let path = path
        .canonicalize()
        .map_err(|e| anyhow::anyhow!("cannot open migrations directory {}: {e}", path.display()))?;

    let migrator = Migrator::new(path.as_path()).await?;

    println!(
        "-- SQLx migration checksums for files in {}\n-- Apply via psql, then restart vantyr-server.\n",
        path.display()
    );

    for m in migrator.iter() {
        if m.migration_type.is_down_migration() {
            continue;
        }
        let hex: String = m.checksum.iter().map(|b| format!("{b:02x}")).collect();
        println!(
            "UPDATE _sqlx_migrations SET checksum = decode('{hex}', 'hex') WHERE version = {};",
            m.version
        );
    }

    Ok(())
}
