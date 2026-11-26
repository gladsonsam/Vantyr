//! Vantyr Network worker-local runtime state.
//!
//! This crate owns two bounded, explicitly small pieces that Vantyr DNS and
//! Vantyr Proxy workers can reuse:
//!
//! * [`persistence`] — a worker-local last-known-good (LKG) policy snapshot
//!   that survives a controller-ack outage.
//! * [`events`] — a bounded queue of decision events.
//!
//! # Trust boundary
//!
//! The on-disk snapshot is **local durability only**. It is not controller
//! authentication: there is no signature, MAC or hash claiming the controller
//! wrote it. A process that can write the snapshot directory can forge local
//! state. Do not present a loaded snapshot as proof that a controller approved
//! it. Controller-side credential checks and canaries remain separate work.
//!
//! The shared policy crate keeps its previous package name until a coordinated
//! rename; this crate reaches it through the `vantyr-network-policy` alias so
//! only that manifest line needs updating later.

pub mod events;
pub mod persistence;

pub use events::{
    EventError, EventQueue, EventQueueConfig, HARD_MAX_BYTES, HARD_MAX_EVENTS,
    HARD_MAX_EVENT_BYTES, MAX_FUTURE_SKEW_SECS,
};
pub use persistence::{
    check_policy_shape, IoHook, LkgError, LkgSnapshot, LkgStore, Persistable, PolicyValidator,
    TypedLkgStore, TypedSnapshot, Validator, WriteHooks, MAX_SNAPSHOT_BYTES, SNAPSHOT_SCHEMA,
};
