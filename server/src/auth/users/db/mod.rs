//! Dashboard users, sessions, 2FA secrets and OIDC identities. Callers import the submodule
//! they need (`db::users`, `db::sessions`, ...).

pub mod identities;
pub mod sessions;
pub mod totp;
pub mod users;
