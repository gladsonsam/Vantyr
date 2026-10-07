//! URL categorization persistence, split by concern. Callers import the submodule they need
//! (`db::settings`, `db::queue`, ...); there are no re-exports.

pub mod categories;
pub mod custom;
pub mod lists;
pub mod lookup;
pub mod overrides;
pub mod queue;
pub mod settings;
