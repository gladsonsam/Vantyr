//! Server-to-agent policy pushes: on connect, and after dashboard edits to auto-update,
//! network/internet-block, app-block, and Recall capture settings.

use std::sync::Arc;

use tracing::warn;
use uuid::Uuid;

use crate::agents::auto_update::db as auto_update_db;
use crate::policy::app_block::db as app_block_db;
use crate::policy::internet_block::db as inet_db;
use crate::recall::db as recall_db;
use crate::state::AppState;
use vantyr_protocol::commands::{BlockRules, SetAutoUpdate, SetNetworkPolicy, SetRecallSettings};
use vantyr_protocol::ServerCommand;

pub(super) async fn push_initial_policies(name: &str, agent_id: Uuid, state: &Arc<AppState>) {
    // Push auto-update policy so agents can be centrally managed.
    if let Ok(enabled) =
        auto_update_db::effective_agent_auto_update_enabled(&state.db, agent_id).await
    {
        if let Err(e) = state.agents.send_command(
            agent_id,
            &ServerCommand::SetAutoUpdate(SetAutoUpdate::new(enabled)),
        ) {
            warn!("Failed to push auto-update policy to {name}: {e}");
        }
    }

    // Push network policy so internet block is re-applied after a reboot.
    if let Ok(blocked) = inet_db::get_agent_internet_blocked(&state.db, agent_id).await {
        if let Err(e) = state.agents.send_command(
            agent_id,
            &ServerCommand::SetNetworkPolicy(SetNetworkPolicy::new(blocked)),
        ) {
            warn!("Failed to push network policy to {name}: {e}");
        }
    }

    // Push scheduled internet-block rules so curfews apply offline.
    if let Ok(rules) = inet_db::internet_block_rules_effective_for_agent(&state.db, agent_id).await
    {
        if let Err(e) = state.agents.send_command(
            agent_id,
            &ServerCommand::SetInternetBlockRules(BlockRules::new(&rules)),
        ) {
            warn!("Failed to push internet block rules to {name}: {e}");
        }
    }

    // Push app block rules so enforcement resumes after a reboot.
    if let Ok(rules) = app_block_db::app_block_rules_effective_for_agent(&state.db, agent_id).await
    {
        if let Err(e) = state.agents.send_command(
            agent_id,
            &ServerCommand::SetAppBlockRules(BlockRules::new(&rules)),
        ) {
            warn!("Failed to push app block rules to {name}: {e}");
        }
    }

    // Push Recall capture settings before the first keyframe of this session, so a
    // cadence change or a kill switch set while this agent was offline applies now.
    if let Ok(Some(settings)) =
        recall_db::settings::effective_recall_settings(&state.db, agent_id).await
    {
        if let Err(e) = state.agents.send_command(
            agent_id,
            &ServerCommand::SetRecallSettings(SetRecallSettings::new(&settings)),
        ) {
            warn!("Failed to push Recall capture settings to {name}: {e}");
        }
    }
}

/// Push the effective auto-update policy to one connected agent.
pub async fn push_auto_update_policy_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    let Ok(enabled) =
        auto_update_db::effective_agent_auto_update_enabled(&state.db, agent_id).await
    else {
        return;
    };
    let _ = state.agents.send_command(
        agent_id,
        &ServerCommand::SetAutoUpdate(SetAutoUpdate::new(enabled)),
    );
}

pub async fn push_auto_update_policy_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.connections.lock().keys().copied().collect();
    for id in ids {
        push_auto_update_policy_to_agent(state, id).await;
    }
}

pub async fn push_network_policy_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    if !crate::agents::capabilities::capability_attemptable(&state.db, agent_id, "network_blocking")
        .await
        .unwrap_or(true)
    {
        return;
    }
    let Ok(blocked) = inet_db::get_agent_internet_blocked(&state.db, agent_id).await else {
        return;
    };
    let _ = state.agents.send_command(
        agent_id,
        &ServerCommand::SetNetworkPolicy(SetNetworkPolicy::new(blocked)),
    );
}

pub async fn push_internet_block_rules_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    if !crate::agents::capabilities::capability_attemptable(&state.db, agent_id, "network_blocking")
        .await
        .unwrap_or(true)
    {
        return;
    }
    let Ok(rules) = inet_db::internet_block_rules_effective_for_agent(&state.db, agent_id).await
    else {
        return;
    };
    let _ = state.agents.send_command(
        agent_id,
        &ServerCommand::SetInternetBlockRules(BlockRules::new(&rules)),
    );
}

pub async fn push_app_block_rules_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    if !crate::agents::capabilities::capability_attemptable(&state.db, agent_id, "app_blocking")
        .await
        .unwrap_or(true)
    {
        return;
    }
    let Ok(rules) = app_block_db::app_block_rules_effective_for_agent(&state.db, agent_id).await
    else {
        return;
    };
    let _ = state.agents.send_command(
        agent_id,
        &ServerCommand::SetAppBlockRules(BlockRules::new(&rules)),
    );
}

/// Push effective Recall capture settings to one agent.
///
/// Settings are per-agent (global row + optional override), so unlike a fleet-wide
/// policy this must be resolved and sent individually. Agents cache the result, so
/// this is what makes a change take effect now rather than at the next reconnect.
pub async fn push_recall_settings_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    let Ok(Some(settings)) =
        recall_db::settings::effective_recall_settings(&state.db, agent_id).await
    else {
        return; // Lookup failed, or no global row yet: the agent keeps its built-in defaults.
    };
    let _ = state.agents.send_command(
        agent_id,
        &ServerCommand::SetRecallSettings(SetRecallSettings::new(&settings)),
    );
}

/// Push capture settings to every connected agent (after a global settings change).
pub async fn push_recall_settings_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.connections.lock().keys().copied().collect();
    for id in ids {
        push_recall_settings_to_agent(state, id).await;
    }
}

pub async fn push_app_block_rules_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.connections.lock().keys().copied().collect();
    for id in ids {
        push_app_block_rules_to_agent(state, id).await;
    }
}

pub async fn push_internet_block_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.connections.lock().keys().copied().collect();
    for id in ids {
        push_network_policy_to_agent(state, id).await;
        push_internet_block_rules_to_agent(state, id).await;
    }
}
