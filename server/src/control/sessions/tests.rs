use super::*;

fn owner() -> LeaseOwner {
    LeaseOwner {
        viewer_connection_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        agent_connection_id: Uuid::new_v4(),
    }
}
fn grant(state: &mut ControlSessions, agent: Uuid, owner: LeaseOwner, now: Instant) -> LeaseGrant {
    let acquired = state.acquire(agent, owner, DEFAULT_LEASE_TTL, now);
    assert!(acquired.cleanup.is_empty());
    acquired.result.unwrap()
}
fn track(
    state: &mut ControlSessions,
    agent: Uuid,
    owner: LeaseOwner,
    token: Uuid,
    cmd: Value,
    now: Instant,
) {
    let result = state.authorize_and_track(agent, owner, token, &cmd, now);
    assert!(result.cleanup.is_empty());
    assert_eq!(result.result, Ok(()));
}

#[test]
fn acquire_is_exclusive_and_exact_owner_idempotent_without_renewal() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let first = grant(&mut state, agent, a, now);
    let again = state.acquire(agent, a, MAX_LEASE_TTL, now + Duration::from_secs(2));
    assert_eq!(again.result, Ok(first));
    let b = LeaseOwner {
        viewer_connection_id: Uuid::new_v4(),
        ..a
    };
    assert_eq!(
        state.acquire(agent, b, DEFAULT_LEASE_TTL, now).result,
        Err(LeaseError::Conflict { owner: a })
    );
    assert_eq!(state.leases.len(), 1);
    assert_ne!(first.token, Uuid::nil());
    assert_eq!(first.token.get_version_num(), 4);
    assert!(!format!("{first:?}").contains(&first.token.to_string()));
}

#[test]
fn all_identity_fields_and_token_are_required() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    for wrong in [
        LeaseOwner {
            viewer_connection_id: Uuid::new_v4(),
            ..a
        },
        LeaseOwner {
            user_id: Uuid::new_v4(),
            ..a
        },
        LeaseOwner {
            agent_connection_id: Uuid::new_v4(),
            ..a
        },
    ] {
        assert_eq!(
            state.authorize(agent, wrong, lease.token, now).result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state.release(agent, wrong, lease.token, now).result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state
                .heartbeat(agent, wrong, lease.token, MAX_LEASE_TTL, now)
                .result,
            Err(LeaseError::Mismatch)
        );
    }
    assert_eq!(
        state.authorize(agent, a, Uuid::new_v4(), now).result,
        Err(LeaseError::Mismatch)
    );
    assert_eq!(
        state.authorize(Uuid::new_v4(), a, lease.token, now).result,
        Err(LeaseError::Missing)
    );
    assert_eq!(state.authorize(agent, a, lease.token, now).result, Ok(()));
}

#[test]
fn exact_deadline_expires_and_idle_sweeps_remove_once() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    assert_eq!(lease.remaining(now), DEFAULT_LEASE_TTL);
    assert_eq!(
        lease.remaining(lease.expires_at + Duration::from_secs(1)),
        Duration::ZERO
    );
    assert!(state
        .expire(lease.expires_at - Duration::from_nanos(1))
        .is_empty());
    let cleanup = state.expire(lease.expires_at);
    assert_eq!(cleanup.len(), 1);
    assert_eq!(cleanup[0].reason, TeardownReason::Expired);
    assert!(state.expire(lease.expires_at).is_empty());
    assert!(state.leases.is_empty());
    assert_eq!(
        state
            .authorize(agent, a, lease.token, lease.expires_at)
            .result,
        Err(LeaseError::Missing)
    );
}

#[test]
fn authorization_expiry_returns_cleanup_even_on_error() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"KeyDown", "key":"control"}),
        now,
    );
    let denied = state.authorize(agent, a, lease.token, lease.expires_at);
    assert_eq!(denied.result, Err(LeaseError::Expired));
    assert_eq!(
        denied.cleanup[0].commands,
        vec![json!({"type":"KeyUp", "key":"control"})]
    );
    assert!(state
        .release(agent, a, lease.token, lease.expires_at)
        .cleanup
        .is_empty());
}

#[test]
fn heartbeat_is_bounded_from_now_and_cannot_resurrect_expired_lease() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let short = state.acquire(agent, a, Duration::ZERO, now).result.unwrap();
    assert_eq!(short.expires_at, now + MIN_LEASE_TTL);
    let at = now + Duration::from_millis(500);
    let renewed = state
        .heartbeat(agent, a, short.token, Duration::MAX, at)
        .result
        .unwrap();
    assert_eq!(renewed.expires_at, at + MAX_LEASE_TTL);
    assert_eq!(renewed.token, short.token);
    let again_at = at + Duration::from_secs(1);
    let again = state
        .heartbeat(agent, a, short.token, Duration::MAX, again_at)
        .result
        .unwrap();
    assert_eq!(again.expires_at, again_at + MAX_LEASE_TTL); // not prior deadline + TTL
    let expired = state.heartbeat(agent, a, short.token, DEFAULT_LEASE_TTL, again.expires_at);
    assert_eq!(expired.result, Err(LeaseError::Expired));
    assert_eq!(expired.cleanup.len(), 1);
    assert!(state.leases.is_empty());
}

#[test]
fn expired_acquire_drains_predecessor_before_new_grant() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let first = grant(&mut state, agent, a, now);
    track(
        &mut state,
        agent,
        a,
        first.token,
        json!({"type":"MouseDown", "x":5, "y":6}),
        now,
    );
    let b = LeaseOwner {
        viewer_connection_id: Uuid::new_v4(),
        ..a
    };
    let acquired = state.acquire(agent, b, DEFAULT_LEASE_TTL, first.expires_at);
    assert_eq!(acquired.cleanup.len(), 1);
    assert_eq!(acquired.cleanup[0].owner, a);
    assert_eq!(
        acquired.cleanup[0].commands,
        vec![json!({"type":"MouseUp", "button":"left", "x":5, "y":6})]
    );
    let successor = acquired.result.unwrap();
    assert_ne!(successor.token, first.token);
    assert_eq!(
        state
            .release(agent, a, first.token, first.expires_at)
            .result,
        Err(LeaseError::Mismatch)
    );
    assert_eq!(
        state
            .heartbeat(agent, a, first.token, DEFAULT_LEASE_TTL, first.expires_at)
            .result,
        Err(LeaseError::Mismatch)
    );
    assert_eq!(
        state
            .authorize(agent, b, successor.token, first.expires_at)
            .result,
        Ok(())
    );
}

#[test]
fn release_drains_each_held_input_once_at_latest_position() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    for _ in 0..5 {
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"KeyDown", "key":"shift"}),
            now,
        );
    }
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"KeyDown", "key":"alt"}),
        now,
    );
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"KeyUp", "key":"alt"}),
        now,
    );
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"MouseDown", "button":"left", "x":1, "y":2}),
        now,
    );
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"MouseDown", "button":"right", "x":1, "y":2}),
        now,
    );
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"MouseMove", "x":30, "y":40}),
        now,
    );
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"MouseUp", "button":"right", "x":30, "y":40}),
        now,
    );
    let release = state.release(agent, a, lease.token, now);
    assert_eq!(release.result, Ok(()));
    assert_eq!(release.cleanup[0].reason, TeardownReason::Released);
    assert_eq!(
        release.cleanup[0].commands,
        vec![
            json!({"type":"KeyUp", "key":"shift"}),
            json!({"type":"MouseUp", "button":"left", "x":30, "y":40})
        ]
    );
    assert_eq!(
        state.release(agent, a, lease.token, now).result,
        Err(LeaseError::Missing)
    );
    assert!(state.revoke_viewer(a.viewer_connection_id).is_empty());
    assert!(state.expire(now + MAX_LEASE_TTL).is_empty());
}

#[test]
fn viewer_disconnect_revokes_all_its_agents_but_not_other_viewers() {
    let mut state = ControlSessions::default();
    let now = Instant::now();
    let a = owner();
    let b = owner();
    let x = Uuid::new_v4();
    let y = Uuid::new_v4();
    let z = Uuid::new_v4();
    grant(&mut state, x, a, now);
    grant(&mut state, y, a, now);
    let b_grant = grant(&mut state, z, b, now);
    let revoked = state.revoke_viewer(a.viewer_connection_id);
    assert_eq!(revoked.len(), 2);
    assert!(revoked
        .iter()
        .all(|cleanup| cleanup.reason == TeardownReason::ViewerDisconnected));
    assert!(state.revoke_viewer(a.viewer_connection_id).is_empty());
    assert_eq!(state.authorize(z, b, b_grant.token, now).result, Ok(()));
}

#[test]
fn reconnect_fences_old_agent_disconnect_and_old_viewer_token() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let first = grant(&mut state, agent, a, now);
    track(
        &mut state,
        agent,
        a,
        first.token,
        json!({"type":"KeyDown", "key":"meta"}),
        now,
    );
    let b = LeaseOwner {
        agent_connection_id: Uuid::new_v4(),
        viewer_connection_id: Uuid::new_v4(),
        ..a
    };
    assert_eq!(
        state.acquire(agent, b, DEFAULT_LEASE_TTL, now).result,
        Err(LeaseError::Conflict { owner: a })
    );
    let revoked = state.revoke_agent(agent, a.agent_connection_id);
    assert_eq!(revoked[0].owner.agent_connection_id, a.agent_connection_id);
    assert_eq!(revoked[0].reason, TeardownReason::AgentDisconnected);
    assert_eq!(
        revoked[0].commands,
        vec![json!({"type":"KeyUp", "key":"meta"})]
    );
    let successor = grant(&mut state, agent, b, now);
    assert!(state.revoke_agent(agent, a.agent_connection_id).is_empty());
    assert!(state.revoke_viewer(a.viewer_connection_id).is_empty());
    assert_eq!(
        state.authorize(agent, b, first.token, now).result,
        Err(LeaseError::Mismatch)
    );
    assert_eq!(
        state.release(agent, a, first.token, now).result,
        Err(LeaseError::Mismatch)
    );
    assert_eq!(
        state
            .heartbeat(agent, a, first.token, MAX_LEASE_TTL, now)
            .result,
        Err(LeaseError::Mismatch)
    );
    assert_eq!(
        state.authorize(agent, b, successor.token, now).result,
        Ok(())
    );
}

#[test]
fn arbitrary_keys_buttons_and_invalid_coordinates_cannot_grow_held_state() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    for i in 0..5000 {
        let rejected = state.authorize_and_track(
            agent,
            a,
            lease.token,
            &json!({"type":"KeyDown", "key":format!("untrusted-{i}")}),
            now,
        );
        assert_eq!(rejected.result, Err(LeaseError::InvalidHeldInput));
    }
    for cmd in [
        json!({"type":"MouseDown", "button":"button999", "x":1,"y":2}),
        json!({"type":"MouseDown", "x":i64::MAX,"y":2}),
        json!({"type":"MouseDown", "x":1.5,"y":2}),
        json!({"type":"KeyDown", "key":null}),
    ] {
        assert_eq!(
            state
                .authorize_and_track(agent, a, lease.token, &cmd, now)
                .result,
            Err(LeaseError::InvalidHeldInput)
        );
    }
    assert_eq!(state.leases.len(), 1);
    assert!(state.release(agent, a, lease.token, now).cleanup[0]
        .commands
        .is_empty());
}

#[test]
fn all_valid_held_keys_and_buttons_have_a_fixed_maximum_cleanup_size() {
    assert!(HELD_KEYS.len() <= 64);
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    for key in HELD_KEYS {
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"KeyDown","key":key}),
            now,
        );
    }
    for button in BUTTONS {
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseDown","button":button,"x":0,"y":0}),
            now,
        );
    }
    assert_eq!(
        state.release(agent, a, lease.token, now).cleanup[0]
            .commands
            .len(),
        HELD_KEYS.len() + BUTTONS.len()
    );
}

#[test]
fn unauthorized_commands_do_not_mutate_successor_tracking() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    let denied = state.authorize_and_track(
        agent,
        owner(),
        lease.token,
        &json!({"type":"KeyDown","key":"control"}),
        now,
    );
    assert_eq!(denied.result, Err(LeaseError::Mismatch));
    assert!(state.release(agent, a, lease.token, now).cleanup[0]
        .commands
        .is_empty());
}

#[test]
fn mouse_button_commands_update_other_held_buttons_to_the_host_cursor() {
    let mut state = ControlSessions::default();
    let agent = Uuid::new_v4();
    let a = owner();
    let now = Instant::now();
    let lease = grant(&mut state, agent, a, now);
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"MouseDown","button":"left","x":1,"y":2}),
        now,
    );
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"MouseDown","button":"right","x":50,"y":60}),
        now,
    );
    track(
        &mut state,
        agent,
        a,
        lease.token,
        json!({"type":"MouseUp","button":"right","x":70,"y":80}),
        now,
    );
    assert_eq!(
        state.release(agent, a, lease.token, now).cleanup[0].commands,
        vec![json!({"type":"MouseUp","button":"left","x":70,"y":80})]
    );
}

#[test]
fn racing_viewers_under_the_integration_mutex_have_exactly_one_winner() {
    use std::sync::{Arc, Barrier, Mutex};
    let state = Arc::new(Mutex::new(ControlSessions::default()));
    let barrier = Arc::new(Barrier::new(2));
    let agent = Uuid::new_v4();
    let now = Instant::now();
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let viewer = owner();
                barrier.wait();
                let acquired = state
                    .lock()
                    .unwrap()
                    .acquire(agent, viewer, DEFAULT_LEASE_TTL, now);
                assert!(acquired.cleanup.is_empty());
                acquired.result
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(LeaseError::Conflict { .. })))
            .count(),
        1
    );
    assert_eq!(state.lock().unwrap().leases.len(), 1);
}
