//! Device policy and settings pushed by the server: auto-update, network and
//! internet blocking, Recall capture tunables and app block rules.

use std::sync::{Arc, Mutex};

use tracing::{info, warn};

use crate::config::Config;
use crate::permissions::Generation;

pub(super) fn set_auto_update(
    val: &serde_json::Value,
    shared_cfg: &Arc<Mutex<Config>>,
    config_tx: &tokio::sync::watch::Sender<Option<Config>>,
) {
    if let Some(enabled) = val["enabled"].as_bool() {
        if let Ok(mut c) = shared_cfg.lock() {
            c.auto_update_enabled = enabled;
            match tokio::task::block_in_place(|| crate::config::save_config_from_user_session(&c)) {
                Ok(()) => {
                    let new_cfg = c.clone();
                    drop(c);
                    let _ = config_tx.send(Some(new_cfg));
                    info!("Auto-update setting updated from server (enabled={enabled}).");
                }
                Err(e) => warn!("Failed to save config (server auto_update): {e}"),
            }
        }
    }
}

pub(super) fn set_network_policy(
    val: &serde_json::Value,
    generation: Option<Generation>,
    shared_cfg: &Arc<Mutex<Config>>,
    config_tx: &tokio::sync::watch::Sender<Option<Config>>,
) {
    let blocked = val["blocked"].as_bool().unwrap_or(false);
    let (hostname, port, was_blocked) = {
        let c = shared_cfg.lock().unwrap_or_else(|e| e.into_inner());
        let (h, p) = crate::platform::network_policy::parse_server_host_port(&c.server_url)
            .unwrap_or_else(|| (String::new(), 443));
        (h, p, c.internet_blocked)
    };
    // Only act when state actually changes (or re-apply on reconnect when already blocked).
    let needs_action = blocked || was_blocked;
    if needs_action {
        let h = hostname;
        crate::permissions::spawn_for_command(generation, async move {
            crate::network_scheduler::apply_network_policy(blocked, h, port, generation).await;
        });
    }
    if let Ok(mut c) = shared_cfg.lock() {
        c.internet_blocked = blocked;
        match tokio::task::block_in_place(|| crate::config::save_config_from_user_session(&c)) {
            Ok(()) => {
                let new_cfg = c.clone();
                drop(c);
                let _ = config_tx.send(Some(new_cfg));
                info!("Network policy updated from server (blocked={blocked}).");
            }
            Err(e) => warn!("Failed to save config (network policy): {e}"),
        }
    }
}

pub(super) fn set_internet_block_rules(
    val: &serde_json::Value,
    generation: Option<Generation>,
    shared_cfg: &Arc<Mutex<Config>>,
) {
    let empty: Vec<serde_json::Value> = Vec::new();
    let rules: Vec<crate::config::StoredInternetBlockRule> = val["rules"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect();
    let (hostname, port, desired, current) = {
        let mut c = shared_cfg.lock().unwrap_or_else(|e| e.into_inner());
        c.internet_block_rules = rules;
        let (h, p) = crate::platform::network_policy::parse_server_host_port(&c.server_url)
            .unwrap_or_else(|| (String::new(), 443));
        let desired_now = if c.internet_block_rules.is_empty() {
            c.internet_blocked
        } else {
            c.internet_block_rules
                .iter()
                .any(|r| crate::schedule::is_active_now_local(&r.schedules))
        };
        let cur = c.internet_blocked;
        if desired_now != cur {
            c.internet_blocked = desired_now;
        }
        if let Err(e) =
            tokio::task::block_in_place(|| crate::config::save_config_from_user_session(&c))
        {
            warn!("Failed to save internet block rules to config: {e}");
        } else {
            info!(
                "Internet block rules updated from server ({} rules).",
                c.internet_block_rules.len()
            );
        }
        (h, p, desired_now, cur)
    };

    if desired != current {
        crate::permissions::spawn_for_command(generation, async move {
            crate::network_scheduler::apply_network_policy(desired, hostname, port, generation)
                .await;
        });
    }
}

/// Applied live (the capture thread re-reads every tick) and cached in config
/// so cadence/quality and the operator kill switch survive restarts and keep
/// applying while offline.
pub(super) fn set_recall_settings(
    val: &serde_json::Value,
    shared_cfg: &Arc<Mutex<Config>>,
    history_settings: &Arc<Mutex<crate::screen_history::HistorySettings>>,
) {
    match serde_json::from_value::<crate::screen_history::HistorySettings>(val["settings"].clone())
    {
        Ok(next) => {
            *history_settings.lock().unwrap_or_else(|e| e.into_inner()) = next;
            if let Ok(mut c) = shared_cfg.lock() {
                c.recall_settings = Some(next);
                if let Err(e) =
                    tokio::task::block_in_place(|| crate::config::save_config_from_user_session(&c))
                {
                    warn!("Failed to save Recall capture settings to config: {e}");
                }
            }
            info!(
                "Recall capture settings updated from server (enabled={}, interval={}ms, q={}).",
                next.enabled, next.interval_ms, next.jpeg_quality
            );
        }
        Err(e) => warn!("Ignoring malformed set_recall_settings payload: {e}"),
    }
}

pub(super) fn set_app_block_rules(
    val: &serde_json::Value,
    shared_cfg: &Arc<Mutex<Config>>,
    shared_rules: &crate::app_block::SharedRules,
) {
    let empty: Vec<serde_json::Value> = Vec::new();
    let rules: Vec<crate::app_block::BlockRule> = val["rules"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect();
    {
        let mut lock = shared_rules.lock().unwrap_or_else(|e| e.into_inner());
        *lock = rules.clone();
    }
    if let Ok(mut c) = shared_cfg.lock() {
        c.app_block_rules = rules
            .iter()
            .map(crate::app_block::BlockRule::to_stored)
            .collect();
        match tokio::task::block_in_place(|| crate::config::save_config_from_user_session(&c)) {
            Ok(()) => {
                info!(
                    "App block rules updated from server ({} rules).",
                    rules.len()
                );
            }
            Err(e) => warn!("Failed to save app block rules to config: {e}"),
        }
    }
}
