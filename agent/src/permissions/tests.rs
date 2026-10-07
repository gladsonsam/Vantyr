use super::fence::{admit_command_in, command_allowed_in, outbound_allowed_in, prepare_binary_in};
use super::store::{read, transaction, transaction_at};
use super::*;
/// Temporary stores are thread-local, but worker counts are process-global.
/// Reserve disjoint revision ranges so parallel fixtures cannot share a key.
fn worker_test_state() -> State {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 32);
    State {
        revision: NEXT.fetch_add(1024, std::sync::atomic::Ordering::Relaxed),
        ..State::default()
    }
}
#[test]
fn final_recall_writer_preserves_pixels_identity_and_closes_secondary_regrant_race() {
    use crate::capture::recall_context::{Context, Generations, Snapshot, Source};
    let mut state = State::default();
    state.local_set(Module::Recall, true).unwrap();
    state.local_set(Module::WindowActivity, true).unwrap();
    let recall = Generation::from_state(&state, Module::Recall);
    let metadata = Generations::from_state(&state);
    let sample = Snapshot {
        identity: "window".into(),
        app: "editor".into(),
        title: "private title".into(),
        source: Source::Hyprland,
        title_truncated: false,
    };
    let c = Context::around(
        Ok(sample.clone()),
        Ok(sample),
        std::time::Duration::ZERO,
        metadata,
    );
    let header =
        serde_json::json!({"uid":"stable-id","captured_at":"2026-10-04T01:02:03Z","context":c});
    let h = serde_json::to_vec(&header).unwrap();
    let mut payload = b"HST\0".to_vec();
    payload.extend_from_slice(&(h.len() as u32).to_le_bytes());
    payload.extend(h);
    payload.extend([7, 8, 9]);
    let queued = tag_recall_binary(payload.clone(), recall, metadata);
    let decode = |b: Vec<u8>| {
        let n = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
        (
            serde_json::from_slice::<serde_json::Value>(&b[8..8 + n]).unwrap(),
            b[8 + n..].to_vec(),
        )
    };
    let (before, _) = decode(prepare_binary_in(&queued, &state).unwrap());
    assert_eq!(before["context"]["window"]["title"], "private title");
    state.local_set(Module::WindowActivity, false).unwrap();
    state.local_set(Module::WindowActivity, true).unwrap();
    let (after, jpeg) = decode(prepare_binary_in(&queued, &state).unwrap());
    assert!(after["context"]["window"]["title"].is_null());
    assert_eq!(after["uid"], header["uid"]);
    assert_eq!(after["captured_at"], header["captured_at"]);
    assert_eq!(jpeg, vec![7, 8, 9]);
    // Missing secondary fence never grants metadata, even while module enabled.
    let (old, _) = decode(prepare_binary_in(&tag_binary(payload, recall), &state).unwrap());
    assert!(old["context"]["window"]["app"].is_null());
    state.local_set(Module::Recall, false).unwrap();
    state.local_set(Module::Recall, true).unwrap();
    assert!(prepare_binary_in(&queued, &state).is_none());
    assert!(prepare_binary_in(b"VGN1", &state).is_none());
}
#[test]
fn parallel_worker_fixtures_keep_exact_counts() {
    let ready = std::sync::Arc::new(std::sync::Barrier::new(16));
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let ready = ready.clone();
            std::thread::spawn(move || {
                let mut state = worker_test_state();
                state.local_set(Module::Terminal, true).unwrap();
                let g = Generation::from_state(&state, Module::Terminal).unwrap();
                let worker = WorkerLease::new(g);
                ready.wait(); // All generations have concurrent registered work.
                assert_eq!(active_workers(g), 1);
                drop(worker);
                assert_eq!(active_workers(g), 0);
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
}
#[test]
fn lower_command_workers_cannot_adopt_regrants_or_wrong_modules() {
    for module in [
        Module::Terminal,
        Module::LiveScreen,
        Module::LiveAudio,
        Module::SoftwareInventory,
    ] {
        let mut old = worker_test_state();
        old.local_set(module, true).unwrap();
        let g = Generation::from_state(&old, module).unwrap();
        with_test_store(&old, || {
            assert!(command_worker(g, module).is_ok());
            assert!(command_worker(g, Module::Files).is_err());
            transaction(
                |s| {
                    s.local_set(module, false)?;
                    s.local_set(module, true)
                },
                true,
            )
            .unwrap();
            assert!(Generation::capture(module).is_some());
            assert!(command_worker(g, module).is_err());
            assert_eq!(active_workers(g), 0);
            // Final outputs still carry the admitted generation and are denied.
            let current = load().unwrap();
            assert!(!outbound_allowed_in(
                &current,
                &stamp(serde_json::json!({"type":"unclassified_result"}), Some(g))
            ));
        });
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn actual_linux_helpers_reject_commands_rotated_after_admission_before_start() {
    let mut old = worker_test_state();
    for module in [
        Module::Terminal,
        Module::LiveScreen,
        Module::SoftwareInventory,
    ] {
        old.local_set(module, true).unwrap();
    }
    with_test_store(&old, || {
        let binding = |kind: &str| {
            let admitted = admit_command(serde_json::json!({"type":kind})).unwrap();
            serde_json::from_value::<Generation>(admitted["__module_generation"].clone()).unwrap()
        };
        let terminal = binding("TerminalStart");
        let screen = binding("start_capture");
        let inventory = binding("CollectSoftware");
        transaction(
            |s| {
                for module in [
                    Module::Terminal,
                    Module::LiveScreen,
                    Module::SoftwareInventory,
                ] {
                    s.local_set(module, false)?;
                    s.local_set(module, true)?;
                }
                Ok(())
            },
            true,
        )
        .unwrap();
        let (out, mut messages) = tokio::sync::mpsc::channel(8);
        let id = uuid::Uuid::new_v4();
        crate::platform::terminal::start(id, 80, 24, out.clone(), terminal);
        assert!(!crate::platform::linux::terminal::has_session_for_test(id));
        let (frames, mut pixels) = tokio::sync::mpsc::channel(8);
        let settings = crate::capture::screen::CaptureSettings::from_request(&Default::default());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        assert!(crate::platform::desktop_capture::start_capture(
            frames.clone(),
            stop.clone(),
            settings,
            screen
        )
        .is_err());
        assert!(crate::capture::screen::start_capture(frames, stop, settings, screen).is_err());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::inventory::software::send_inventory(out, inventory));
        assert!(messages.try_recv().is_err());
        assert!(pixels.try_recv().is_err());
        for g in [terminal, screen, inventory] {
            assert_eq!(active_workers(g), 0);
        }
    });
}

#[test]
fn command_allowed_rejects_old_server_revision_after_regrant() {
    let mut s = State::default();
    s.local_set(Module::RemoteInput, true).unwrap();
    let old = Generation::from_state(&s, Module::RemoteInput).unwrap();
    let command = stamp(serde_json::json!({"type":"KeyChar", "char":"a"}), Some(old));
    assert!(command_allowed_in(&s, &command));
    assert_eq!(admit_command_in(&s, command.clone()), Some(command.clone()));
    s.local_set(Module::RemoteInput, false).unwrap();
    s.local_set(Module::RemoteInput, true).unwrap();
    assert!(!command_allowed_in(&s, &command));
    assert!(admit_command_in(&s, command).is_none());
    let current = Generation::from_state(&s, Module::RemoteInput).unwrap();
    let legacy = serde_json::json!({"type":"KeyChar", "char":"a"});
    let admitted = admit_command_in(&s, legacy.clone()).unwrap();
    assert_eq!(admitted, stamp(legacy, Some(current)));
    assert!(command_allowed_in(&s, &admitted));
    for invalid in [
        serde_json::Value::Null,
        serde_json::json!({"module":"files","revision":current.revision}),
        serde_json::json!({"module":"unknown","revision":current.revision}),
    ] {
        let mut command = admitted.clone();
        command["__module_generation"] = invalid;
        assert!(!command_allowed_in(&s, &command));
        assert!(admit_command_in(&s, command).is_none());
    }
}

#[test]
fn buffered_events_require_their_original_generation() {
    let mut s = State::default();
    s.local_set(Module::Files, true).unwrap();
    let g = Generation::from_state(&s, Module::Files).unwrap();
    let v = stamp(
        serde_json::json!({"type":"file_chunk","data":"old"}),
        Some(g),
    );
    assert!(outbound_allowed_in(&s, &v));
    assert!(!outbound_allowed_in(
        &s,
        &serde_json::json!({"type":"file_chunk"})
    ));
    s.local_set(Module::Files, false).unwrap();
    s.local_set(Module::Files, true).unwrap();
    assert!(!outbound_allowed_in(&s, &v));
    assert!(!outbound_allowed_in(
        &s,
        &serde_json::json!({"type":"batch","events":[v]})
    ));
    let wrong = stamp(
        serde_json::json!({"type":"terminal_output"}),
        Generation::from_state(&s, Module::Files),
    );
    assert!(!outbound_allowed_in(&s, &wrong));
}
#[test]
fn old_generation_never_matches_after_regrant() {
    let mut s = State::default();
    s.local_set(Module::Scripts, true).unwrap();
    let old = Generation::from_state(&s, Module::Scripts).unwrap();
    s.local_set(Module::Scripts, false).unwrap();
    assert!(!old.matches(&s));
    s.local_set(Module::Scripts, true).unwrap();
    assert!(!old.matches(&s));
    let new = Generation::from_state(&s, Module::Scripts).unwrap();
    assert!(new.matches(&s));
    assert_ne!(old, new);
}
#[test]
fn module_changes_do_not_cancel_other_generations() {
    let mut s = State::default();
    s.local_set(Module::Recall, true).unwrap();
    let g = Generation::from_state(&s, Module::Recall).unwrap();
    s.local_set(Module::Files, true).unwrap();
    assert!(g.matches(&s));
}
#[test]
fn local_barrier_tracks_work_until_lease_drop() {
    let g = Generation {
        module: Module::LiveAudio,
        revision: 998877,
    };
    let a = WorkerLease::new(g);
    let b = WorkerLease::new(g);
    assert_eq!(active_workers(g), 2);
    drop(a);
    assert_eq!(active_workers(g), 1);
    drop(b);
    assert_eq!(active_workers(g), 0);
}
#[test]
fn binary_fence_preserves_existing_payload() {
    let g = Generation {
        module: Module::LiveScreen,
        revision: 12,
    };
    let payload = vec![1, 2, 3];
    let b = tag_binary(payload.clone(), Some(g));
    assert_eq!(&b[..4], b"VGN1");
    let n = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
    assert_eq!(
        serde_json::from_slice::<Generation>(&b[8..8 + n]).unwrap(),
        g
    );
    assert_eq!(&b[8 + n..], payload);
}
#[test]
fn typed_registry_and_input_commands() {
    assert!(serde_json::from_str::<Module>("\"unknown\"").is_err());
    for command in [
        "MouseMove",
        "MouseClick",
        "MouseDoubleClick",
        "MouseDown",
        "MouseUp",
        "MouseScroll",
        "TypeText",
        "KeyPress",
        "KeyDown",
        "KeyUp",
        "KeyChar",
        "Notify",
    ] {
        assert_eq!(command_module(command), Some(Module::RemoteInput));
    }
    for command in [
        "screenshot",
        "Screenshot",
        "grant_module",
        "enable_module",
        "arbitrary_unknown",
        "set_local_ui_password_hash",
    ] {
        assert!(!command_allowed(&serde_json::json!({"type":command})));
    }
    assert_eq!(command_module("start_capture"), Some(Module::LiveScreen));
    assert_eq!(command_module("start_audio"), Some(Module::LiveAudio));
}
#[test]
fn serialized_writers_preserve_all_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("permissions.json");
    std::thread::scope(|scope| {
        for &m in MODULES {
            let p = &path;
            scope.spawn(move || {
                transaction_at(p, |s| s.local_set(m, true), true).unwrap();
            });
        }
    });
    let s = read(&path).unwrap();
    assert_eq!(s.revision, MODULES.len() as u64);
    for &m in MODULES {
        assert!(s.enabled(m));
    }
}
#[test]
fn durable_replay_and_corrupt_store_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("permissions.json");
    transaction_at(&p, |s| s.disable(Module::Recall, 0, "id"), true).unwrap();
    let (_, r) = transaction_at(&p, |s| s.disable(Module::Recall, 0, "id"), true).unwrap();
    assert_eq!(r, DisableResult::Duplicate);
    std::fs::write(&p, b"corrupt").unwrap();
    assert!(transaction_at(&p, |s| s.local_set(Module::Recall, true), true).is_err());
    assert_eq!(std::fs::read(&p).unwrap(), b"corrupt");
}
#[test]
fn legacy_off() {
    let s: State = serde_json::from_str("{}").unwrap();
    for &m in MODULES {
        assert!(!s.enabled(m));
    }
}
#[test]
fn revoke_replay_cannot_revoke_later_grant() {
    let mut s = State::default();
    s.local_set(Module::Recall, true).unwrap();
    assert_eq!(
        s.disable(Module::Recall, 1, "a").unwrap(),
        DisableResult::Disabled
    );
    s.local_set(Module::Recall, true).unwrap();
    assert_eq!(
        s.disable(Module::Recall, 1, "a").unwrap(),
        DisableResult::Duplicate
    );
    assert!(s.enabled(Module::Recall));
    assert_eq!(
        s.disable(Module::Recall, 1, "b").unwrap(),
        DisableResult::Stale
    );
    assert_eq!(
        s.disable(Module::Files, 0, "a").unwrap(),
        DisableResult::Conflict
    );
}
#[test]
fn persisted_receipts() {
    let mut s = State::default();
    s.disable(Module::Files, 0, "x").unwrap();
    let mut s: State = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
    assert_eq!(
        s.disable(Module::Files, 0, "x").unwrap(),
        DisableResult::Duplicate
    );
}
#[test]
fn invalid_ids_and_overflow_fail_without_grant() {
    let mut s = State::default();
    assert!(s.disable(Module::Recall, 0, "").is_err());
    s.revision = u64::MAX;
    assert!(s.local_set(Module::Recall, true).is_err());
    assert!(!s.enabled(Module::Recall));
}
