//! Capability-aware status. The documentation version and the controller's
//! reported `applicationVersion` are distinct facts. `NetworkUpdate` is a
//! documented operation but live writes are not part of this slice.

use std::collections::BTreeMap;

use crate::config::API_DOC_VERSION;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Operation {
    Info,
    Sites,
    Networks,
    NetworkDetail,
    Clients,
    NetworkUpdate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Support {
    Supported,
    Unsupported,
    Unavailable,
    AuthDenied,
    /// Documented in the pinned contract, but never executed here.
    WriteDeferred,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct Capabilities {
    pub api_doc_version: String,
    pub application_version: Option<String>,
    pub operations: BTreeMap<Operation, Support>,
}

impl Capabilities {
    pub fn from_info(application_version: String) -> Self {
        let mut operations = BTreeMap::new();
        for op in [
            Operation::Info,
            Operation::Sites,
            Operation::Networks,
            Operation::NetworkDetail,
            Operation::Clients,
        ] {
            operations.insert(op, Support::Supported);
        }
        operations.insert(Operation::NetworkUpdate, Support::WriteDeferred);
        Self {
            api_doc_version: API_DOC_VERSION.to_owned(),
            application_version: Some(application_version),
            operations,
        }
    }

    pub fn record(&mut self, operation: Operation, support: Support) {
        self.operations.insert(operation, support);
    }

    pub fn support(&self, operation: Operation) -> Support {
        self.operations
            .get(&operation)
            .cloned()
            .unwrap_or(Support::Unknown)
    }

    /// Always false in this slice: no live mutating HTTP method exists.
    pub fn live_writes_permitted(&self) -> bool {
        false
    }
}
