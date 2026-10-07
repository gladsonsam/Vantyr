//! Capture-associated foreground observations, never an atomic pixel attribution.
//! Providers are sampled on the capture thread; upload never resamples context.
use crate::permissions::{Generation, Module, State};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};
use vantyr_protocol::recall_context::{
    bounded_clean, CONTEXT_SCOPE, CONTEXT_VERSION, MAX_APP_BYTES, MAX_BRACKET_MS,
    MAX_CONTEXT_BYTES, MAX_TITLE_BYTES,
};
pub use vantyr_protocol::recall_context::{
    BrowserContext, Context, Reason, Source, Status, WindowContext,
};

#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

pub const BRACKET_BUDGET: Duration = Duration::from_millis(250);
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Generations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_generation: Option<Generation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_generation: Option<Generation>,
}
impl Generations {
    pub fn capture() -> Self {
        Self::from_state(&crate::permissions::load().unwrap_or_default())
    }
    pub fn from_state(s: &State) -> Self {
        Self {
            window_generation: Generation::from_state(s, Module::WindowActivity),
            browser_generation: Generation::from_state(s, Module::BrowserUrls),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    // Native window AND process/session identity. Private, never persisted/exported.
    pub identity: String,
    pub app: String,
    pub title: String,
    pub source: Source,
    pub title_truncated: bool,
}
pub fn snapshot(generation: Option<Generation>) -> Result<Snapshot, Reason> {
    let _lease = generation
        .filter(|g| g.module == Module::WindowActivity)
        .map(crate::permissions::WorkerLease::new);
    if !generation.is_some_and(|g| g.module == Module::WindowActivity && g.valid_fresh()) {
        return Err(Reason::ModuleDisabled);
    }
    imp::snapshot()
}
fn bounded(raw: &str, cap: usize) -> (Option<String>, bool) {
    let (text, truncated) = bounded_clean(raw, cap);
    (if text.is_empty() { None } else { Some(text) }, truncated)
}
/// The agent-side half of [`Context`]: building one around a capture and
/// re-checking it against the current grants (`Context` itself lives in `vantyr-protocol`).
pub trait ContextExt: Sized {
    fn around(
        before: Result<Snapshot, Reason>,
        after: Result<Snapshot, Reason>,
        elapsed: Duration,
        generations: Generations,
    ) -> Self;
    fn sanitize(&mut self, generations: Generations);
    fn sanitize_in(&mut self, state: &State, generations: Generations);
}
impl ContextExt for Context {
    fn around(
        before: Result<Snapshot, Reason>,
        after: Result<Snapshot, Reason>,
        elapsed: Duration,
        generations: Generations,
    ) -> Self {
        let window = if generations.window_generation.is_none() {
            WindowContext::empty(Status::NotCollected, Reason::ModuleDisabled)
        } else if elapsed > BRACKET_BUDGET {
            WindowContext::empty(Status::Unknown, Reason::SampleTimeout)
        } else {
            match (before, after) {
                (Ok(a), Ok(b)) if a == b && !a.identity.is_empty() => {
                    let (app, app_truncated) = bounded(&a.app, MAX_APP_BYTES);
                    let (title, title_truncated) = bounded(&a.title, MAX_TITLE_BYTES);
                    WindowContext {
                        status: Status::Observed,
                        reason: None,
                        source: a.source,
                        app: if app_truncated { None } else { app },
                        title,
                        title_truncated: a.title_truncated || title_truncated,
                    }
                }
                (Ok(_), Ok(_)) => WindowContext::empty(Status::Uncertain, Reason::Changed),
                (Err(Reason::Changed), _) | (_, Err(Reason::Changed)) => {
                    WindowContext::empty(Status::Uncertain, Reason::Changed)
                }
                (Err(e), _) | (_, Err(e)) => WindowContext::empty(Status::Unknown, e),
            }
        };
        let browser_granted = generations.browser_generation.is_some();
        let mut c = Self {
            version: CONTEXT_VERSION,
            scope: CONTEXT_SCOPE.into(),
            bracket_ms: elapsed.as_millis().min(u128::from(MAX_BRACKET_MS)) as u32,
            monitor_relation: "unknown".into(),
            window,
            browser: BrowserContext {
                status: if browser_granted {
                    Status::Unknown
                } else {
                    Status::NotCollected
                },
                reason: Some(if browser_granted {
                    Reason::Unsupported
                } else {
                    Reason::ModuleDisabled
                }),
                source: Source::None,
                url: None,
                url_host: None,
            },
            grant_revisions: BTreeMap::new(),
        };
        if c.window.status == Status::Observed {
            if let Some(g) = generations.window_generation {
                c.grant_revisions.insert(Module::WindowActivity, g.revision);
            }
        }
        c
    }
    fn sanitize(&mut self, generations: Generations) {
        self.sanitize_in(&crate::permissions::load().unwrap_or_default(), generations);
    }
    fn sanitize_in(&mut self, state: &State, generations: Generations) {
        self.monitor_relation = "unknown".into();
        let valid = generations
            .window_generation
            .filter(|g| g.module == Module::WindowActivity && g.matches(state));
        if valid.is_none() {
            self.window = WindowContext::empty(
                Status::NotCollected,
                if generations.window_generation.is_some() {
                    Reason::Revoked
                } else {
                    Reason::ModuleDisabled
                },
            );
            self.grant_revisions.remove(&Module::WindowActivity);
        } else if self.window.status == Status::Observed {
            let (app, long) = bounded(self.window.app.as_deref().unwrap_or(""), MAX_APP_BYTES);
            let (title, truncated) =
                bounded(self.window.title.as_deref().unwrap_or(""), MAX_TITLE_BYTES);
            self.window.app = if long { None } else { app };
            self.window.title = title;
            self.window.title_truncated |= truncated;
            self.grant_revisions
                .insert(Module::WindowActivity, valid.unwrap().revision);
        } else {
            self.window.app = None;
            self.window.title = None;
            self.grant_revisions.remove(&Module::WindowActivity);
        }
        // Browser values unsupported in this slice, including deserialized spool values.
        let browser_valid = generations
            .browser_generation
            .is_some_and(|g| g.module == Module::BrowserUrls && g.matches(state));
        self.browser = BrowserContext {
            status: if browser_valid {
                Status::Unknown
            } else {
                Status::NotCollected
            },
            reason: Some(if browser_valid {
                Reason::Unsupported
            } else if generations.browser_generation.is_some() {
                Reason::Revoked
            } else {
                Reason::ModuleDisabled
            }),
            source: Source::None,
            url: None,
            url_host: None,
        };
        self.grant_revisions
            .retain(|m, _| *m == Module::WindowActivity);
    }
}
/// Unknown/future/bad context must not destroy an otherwise valid old spool frame.
pub fn deserialize_context<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Context>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(d)?;
    Ok(value.and_then(|v| {
        if serde_json::to_vec(&v).ok()?.len() > MAX_CONTEXT_BYTES {
            return None;
        }
        serde_json::from_value::<Context>(v)
            .ok()
            .filter(Context::is_supported)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> State {
        let mut s = State::default();
        s.local_set(Module::Recall, true).unwrap();
        s.local_set(Module::WindowActivity, true).unwrap();
        s
    }
    fn sample() -> Snapshot {
        Snapshot {
            identity: "window:1:pid:2:start:3".into(),
            app: "editor".into(),
            title: "Document".into(),
            source: Source::Hyprland,
            title_truncated: false,
        }
    }
    #[test]
    fn grants_are_independent_and_no_browser_values() {
        let mut s = state();
        s.local_set(Module::WindowActivity, false).unwrap();
        s.local_set(Module::BrowserUrls, true).unwrap();
        let g = Generations::from_state(&s);
        let mut c = Context::around(Ok(sample()), Ok(sample()), Duration::ZERO, g);
        c.sanitize_in(&s, g);
        assert_eq!(c.window.status, Status::NotCollected);
        assert!(c.window.app.is_none());
        assert_eq!(c.browser.reason, Some(Reason::Unsupported));
        assert!(c.browser.url.is_none());
    }
    #[test]
    fn observed_changed_failed_and_timeout_are_truthful() {
        let g = Generations::from_state(&state());
        let a = sample();
        assert_eq!(
            Context::around(Ok(a.clone()), Ok(a.clone()), Duration::ZERO, g)
                .window
                .status,
            Status::Observed
        );
        let mut b = a.clone();
        b.identity = "other window same process".into();
        let c = Context::around(Ok(a.clone()), Ok(b), Duration::ZERO, g);
        assert_eq!(c.window.status, Status::Uncertain);
        assert!(c.window.title.is_none());
        assert_eq!(
            Context::around(Err(Reason::ReadFailed), Ok(a.clone()), Duration::ZERO, g)
                .window
                .reason,
            Some(Reason::ReadFailed)
        );
        assert_eq!(
            Context::around(Ok(a.clone()), Ok(a), Duration::from_millis(251), g)
                .window
                .reason,
            Some(Reason::SampleTimeout)
        );
    }
    #[test]
    fn revoke_regrant_never_relabels_and_bounds_are_utf8_safe() {
        let mut s = state();
        let g = Generations::from_state(&s);
        let mut a = sample();
        a.title = format!("\0{}", "文".repeat(1000));
        a.app = "x".repeat(257);
        let mut c = Context::around(Ok(a.clone()), Ok(a), Duration::ZERO, g);
        assert!(c.window.app.is_none());
        assert!(c.window.title.as_ref().unwrap().len() <= 1024);
        assert!(c.window.title_truncated);
        s.local_set(Module::WindowActivity, false).unwrap();
        s.local_set(Module::WindowActivity, true).unwrap();
        c.sanitize_in(&s, g);
        assert_eq!(c.window.reason, Some(Reason::Revoked));
        assert!(c.window.title.is_none());
    }
    #[test]
    fn failures_do_not_trigger_context_dedup() {
        let g = Generations::from_state(&state());
        for reason in [
            Reason::ReadFailed,
            Reason::SampleTimeout,
            Reason::Unsupported,
        ] {
            assert!(Context::around(Err(reason), Err(reason), Duration::ZERO, g)
                .signature()
                .is_none());
        }
    }
}
