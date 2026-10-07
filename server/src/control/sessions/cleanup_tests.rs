use super::*;

#[test]
fn only_commands_the_drain_can_emit_count_as_cleanup() {
    let mut held = HeldInput::default();
    held.track(&json!({"type":"KeyDown","key":"shift"}))
        .unwrap();
    held.track(&json!({"type":"MouseDown","button":"right","x":4,"y":5}))
        .unwrap();
    let commands = held.drain();
    assert_eq!(commands.len(), 2);
    assert!(commands.iter().all(is_cleanup_command));

    assert!(!is_cleanup_command(
        &json!({"type":"KeyDown","key":"shift"})
    ));
    assert!(!is_cleanup_command(
        &json!({"type":"KeyUp","key":"printscreen"})
    ));
    assert!(!is_cleanup_command(
        &json!({"type":"MouseUp","button":"side","x":0,"y":0})
    ));
    assert!(!is_cleanup_command(
        &json!({"type":"MouseUp","button":"left","x":0,"y":i64::MAX})
    ));
    assert!(!is_cleanup_command(&json!({"type":"TypeText","text":"x"})));
}
