use serde_json::json;

use super::*;

#[test]
fn mouse_coordinates_must_fit_i32() {
    assert!(is_valid("MouseMove", &json!({"x": 10, "y": -4})));
    assert!(!is_valid("MouseMove", &json!({"x": 10})));
    assert!(!is_valid("MouseMove", &json!({"x": i64::MAX, "y": 0})));
}

#[test]
fn mouse_buttons_are_a_fixed_set() {
    assert!(is_valid(
        "MouseDown",
        &json!({"x": 1, "y": 1, "button": "left"})
    ));
    assert!(is_valid("MouseUp", &json!({"x": 1, "y": 1})));
    assert!(!is_valid(
        "MouseDown",
        &json!({"x": 1, "y": 1, "button": "side"})
    ));
}

#[test]
fn keys_and_text_are_bounded() {
    assert!(is_valid("KeyPress", &json!({"key": "enter"})));
    assert!(!is_valid("KeyPress", &json!({"key": "printscreen"})));
    assert!(is_valid("KeyChar", &json!({"char": "é"})));
    assert!(!is_valid("KeyChar", &json!({"char": "ab"})));
    let fits = "a".repeat(MAX_TYPE_TEXT_CHARS);
    let too_long = "a".repeat(MAX_TYPE_TEXT_CHARS + 1);
    assert!(is_valid("TypeText", &json!({ "text": fits })));
    assert!(!is_valid("TypeText", &json!({ "text": too_long })));
}

#[test]
fn file_commands_need_non_blank_bounded_paths() {
    assert!(is_valid("DeletePath", &json!({"path": "/tmp/x"})));
    assert!(!is_valid("DeletePath", &json!({"path": "  "})));
    let too_long = "p".repeat(MAX_FS_PATH_CHARS + 1);
    assert!(!is_valid("DeletePath", &json!({ "path": too_long })));
    assert!(is_valid("RenamePath", &json!({"src": "a", "dst": "b"})));
    assert!(!is_valid("RenamePath", &json!({"src": "a"})));
    assert!(is_valid("ListDir", &json!({})));
}

#[test]
fn write_file_chunks_must_be_in_range() {
    let chunk = |index: u64, total: u64| json!({"path": "f", "chunk_index": index, "total_chunks": total, "data": "AA=="});
    assert!(is_valid("WriteFileChunk", &chunk(0, 1)));
    assert!(!is_valid("WriteFileChunk", &chunk(1, 1)));
    assert!(!is_valid("WriteFileChunk", &chunk(0, 0)));
}

#[test]
fn unknown_commands_are_rejected() {
    assert!(is_valid("LockHost", &json!({})));
    assert!(!is_valid("FormatDisk", &json!({})));
    assert!(!is_valid("", &json!({})));
}
