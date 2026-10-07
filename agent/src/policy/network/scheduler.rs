//! Apply server/network blocking policy and run the internet curfew scheduler task.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::warn;

use crate::config::Config;

pub async fn apply_network_policy(
    blocked: bool,
    hostname: String,
    port: u16,
    generation: Option<crate::permissions::Generation>,
) {
    if blocked
        && !generation
            .is_some_and(|g| g.module == crate::permissions::Module::NetworkPolicy && g.valid())
    {
        return;
    }
    super::imp::apply_policy(blocked, hostname, port, generation).await;
}

pub async fn run_internet_curfew_scheduler(shared_cfg: Arc<Mutex<Config>>) {
    use crate::policy::schedule as sched;

    let mut last_applied: Option<bool> = None;
    // Whether the last attempt to lift the block (grant off) failed, so a persistent
    // failure is logged once instead of every tick.
    let mut remove_failed = false;
    let mut interval = tokio::time::interval(Duration::from_secs(20));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if !crate::permissions::allowed(crate::permissions::Module::NetworkPolicy) {
            // A revoked grant must not leave the machine cut off.
            match crate::policy::network::run_blocking(crate::policy::network::remove_block).await {
                Ok(()) => remove_failed = false,
                Err(e) => {
                    if !std::mem::replace(&mut remove_failed, true) {
                        warn!("Could not lift the network block after the grant was revoked: {e}");
                    }
                }
            }
            last_applied = None;
            continue;
        }

        let (hostname, port, desired, current, has_rules) = {
            let c = shared_cfg.lock().unwrap_or_else(|e| e.into_inner());
            let (h, p) = crate::policy::network::parse_server_host_port(&c.server_url)
                .unwrap_or_else(|| (String::new(), 443));
            let has_rules = !c.internet_block_rules.is_empty();
            let desired = if has_rules {
                c.internet_block_rules
                    .iter()
                    .any(|r| sched::is_active_now_local(&r.schedules))
            } else {
                c.internet_blocked
            };
            (h, p, desired, c.internet_blocked, has_rules)
        };

        let baseline = last_applied.unwrap_or(current);
        if desired == baseline {
            continue;
        }

        apply_network_policy(
            desired,
            hostname.clone(),
            port,
            crate::permissions::Generation::capture(crate::permissions::Module::NetworkPolicy),
        )
        .await;

        // Persist the applied state so we resume correctly after a reboot.
        if has_rules {
            if let Ok(mut c) = shared_cfg.lock() {
                c.internet_blocked = desired;
                if let Err(e) = crate::config::save_config_from_user_session(&c) {
                    warn!("Failed to save config (internet curfew scheduler): {e}");
                }
            }
        }
        last_applied = Some(desired);
    }
}
