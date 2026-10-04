//! Interactive remote terminal backed by a Windows pseudo-console (ConPTY).
//!
//! One ConPTY-backed shell per `session_id`. The shell runs in the **current
//! (user) session** — `handle_server_command` is dispatched from the per-user
//! companion. Output is streamed to the server as base64 `terminal_output`
//! frames; `terminal_exit` is sent when the shell ends.
//!
//! Local module permission gates startup/input; a watchdog closes sessions on
//! revocation. Server-side role checks are an additional boundary.
//!
//! ⚠️  RUNTIME-UNTESTED: the ConPTY FFI is compile-verified only. Test on a real
//! agent before relying on it. All failures are logged and surfaced as a
//! `terminal_exit` rather than panicking the companion.

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// Start a new shell for `session_id`. Spawns a reader thread that streams
/// output via `out_tx`. No-op (logs) on non-Windows builds.
pub fn start(
    session_id: Uuid,
    cols: u16,
    rows: u16,
    out_tx: mpsc::Sender<Message>,
    generation: crate::permissions::Generation,
) {
    let Ok(_startup_lease) =
        crate::permissions::command_worker(generation, crate::permissions::Module::Terminal)
    else {
        return;
    };

    #[cfg(windows)]
    {
        imp::start(session_id, cols, rows, out_tx, generation);
    }
    #[cfg(not(windows))]
    {
        let _ = (cols, rows);
        let _ = out_tx.try_send(Message::Text(
            serde_json::json!({ "type": "terminal_exit", "session_id": session_id.to_string() })
                .to_string(),
        ));
        tracing::warn!("terminal: unsupported on this platform");
    }
}

/// Write user input (UTF-8) to the shell's stdin.
pub fn input(session_id: Uuid, data: &str) {
    if !crate::permissions::allowed(crate::permissions::Module::Terminal) {
        close(session_id);
        return;
    }
    #[cfg(windows)]
    {
        imp::input(session_id, data);
    }
    #[cfg(not(windows))]
    {
        let _ = (session_id, data);
    }
}

/// Resize the pseudo-console.
pub fn resize(session_id: Uuid, cols: u16, rows: u16) {
    #[cfg(windows)]
    {
        imp::resize(session_id, cols, rows);
    }
    #[cfg(not(windows))]
    {
        let _ = (session_id, cols, rows);
    }
}

/// Terminate and clean up the session.
pub fn close(session_id: Uuid) {
    #[cfg(windows)]
    {
        imp::close(session_id);
    }
    #[cfg(not(windows))]
    {
        let _ = session_id;
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    use base64::Engine;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;
    use tracing::warn;
    use uuid::Uuid;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows::Win32::System::Console::{
        ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        TerminateProcess, UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
        STARTUPINFOEXW,
    };

    /// Live session state. Raw handles are process-global; safe to move across
    /// threads, so we assert `Send` (the windows newtypes hold raw pointers).
    struct Session {
        hpcon: HPCON,
        input_write: HANDLE,
        proc: HANDLE,
        generation: crate::permissions::Generation,
        tree: crate::process_tree::ProcessTree,
        _lease: crate::permissions::WorkerLease,
    }
    unsafe impl Send for Session {}

    fn registry() -> &'static Mutex<HashMap<Uuid, Session>> {
        static R: OnceLock<Mutex<HashMap<Uuid, Session>>> = OnceLock::new();
        R.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn exit_frame(session_id: Uuid) -> Message {
        Message::Text(
            serde_json::json!({ "type": "terminal_exit", "session_id": session_id.to_string() })
                .to_string(),
        )
    }

    pub(super) fn start(
        session_id: Uuid,
        cols: u16,
        rows: u16,
        out_tx: mpsc::Sender<Message>,
        generation: crate::permissions::Generation,
    ) {
        match unsafe { spawn_conpty(cols.max(2), rows.max(1)) } {
            Ok((hpcon, input_write, output_read, proc, thread)) => {
                let tree = match crate::process_tree::ProcessTree::attach(unsafe {
                    windows::Win32::System::Threading::GetProcessId(proc)
                }) {
                    Ok(tree) => tree,
                    Err(e) => {
                        unsafe {
                            let _ = TerminateProcess(proc, 0);
                            let _ = CloseHandle(proc);
                            let _ = CloseHandle(thread);
                            let _ = CloseHandle(input_write);
                            let _ = CloseHandle(output_read);
                            ClosePseudoConsole(hpcon);
                        }
                        warn!("terminal containment failed: {e}");
                        return;
                    }
                };
                if unsafe { windows::Win32::System::Threading::ResumeThread(thread) } == u32::MAX {
                    drop(tree);
                    unsafe {
                        let _ = TerminateProcess(proc, 0);
                        let _ = CloseHandle(proc);
                        let _ = CloseHandle(thread);
                        let _ = CloseHandle(input_write);
                        let _ = CloseHandle(output_read);
                        ClosePseudoConsole(hpcon);
                    }
                    warn!("terminal: failed to resume contained shell");
                    return;
                }
                // Close the resumed thread handle.
                unsafe {
                    let _ = CloseHandle(thread);
                }
                registry().lock().unwrap_or_else(|e| e.into_inner()).insert(
                    session_id,
                    Session {
                        hpcon,
                        input_write,
                        proc,
                        generation,
                        tree,
                        _lease: crate::permissions::WorkerLease::new(generation),
                    },
                );
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if !generation.valid() {
                        close_generation(session_id, generation);
                        break;
                    }
                    if !contains(session_id) {
                        break;
                    }
                });
                // Reader thread: pump pty output → server until EOF.
                let read_handle = SendHandle(output_read);
                let reader_lease = crate::permissions::WorkerLease::new(generation);
                std::thread::spawn(move || {
                    let _lease = reader_lease;
                    // Rebind so the closure captures the whole `SendHandle` (Send),
                    // not just the inner non-Send `HANDLE` field.
                    let read_handle = read_handle;
                    reader_loop(session_id, read_handle.0, out_tx, generation);
                });
            }
            Err(e) => {
                warn!("terminal: ConPTY start failed: {e}");
                let _ = out_tx.try_send(exit_frame(session_id));
            }
        }
    }

    pub(super) fn input(session_id: Uuid, data: &str) {
        let bytes = data.as_bytes();
        let handle = {
            let map = registry().lock().unwrap_or_else(|e| e.into_inner());
            map.get(&session_id)
                .filter(|s| s.generation.valid())
                .map(|s| SendHandle(s.input_write))
        };
        if let Some(h) = handle {
            let mut written = 0u32;
            unsafe {
                let _ = WriteFile(h.0, Some(bytes), Some(&mut written), None);
            }
        }
    }

    pub(super) fn resize(session_id: Uuid, cols: u16, rows: u16) {
        let map = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = map.get(&session_id) {
            if !s.generation.valid() {
                return;
            }
            let size = COORD {
                X: cols.max(2) as i16,
                Y: rows.max(1) as i16,
            };
            unsafe {
                let _ = ResizePseudoConsole(s.hpcon, size);
            }
        }
    }

    pub(super) fn contains(id: Uuid) -> bool {
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&id)
    }
    pub(super) fn close_generation(session_id: Uuid, generation: crate::permissions::Generation) {
        close_matching(session_id, Some(generation));
    }
    pub(super) fn close(session_id: Uuid) {
        close_matching(session_id, None);
    }
    fn close_matching(session_id: Uuid, generation: Option<crate::permissions::Generation>) {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        if generation.is_some_and(|g| map.get(&session_id).is_some_and(|s| s.generation != g)) {
            return;
        }
        let removed = map.remove(&session_id);
        drop(map);
        if let Some(s) = removed {
            drop(s.tree);
            unsafe {
                let _ = TerminateProcess(s.proc, 0);
                ClosePseudoConsole(s.hpcon);
                let _ = CloseHandle(s.input_write);
                let _ = CloseHandle(s.proc);
            }
        }
    }

    /// `HANDLE`/`HPCON` hold raw pointers and aren't `Send`; this wrapper lets us
    /// move a handle into a thread. Sound because Win32 handles are global.
    struct SendHandle(HANDLE);
    unsafe impl Send for SendHandle {}

    fn reader_loop(
        session_id: Uuid,
        output_read: HANDLE,
        out_tx: mpsc::Sender<Message>,
        generation: crate::permissions::Generation,
    ) {
        let mut buf = [0u8; 8192];
        loop {
            let mut read = 0u32;
            let ok = unsafe { ReadFile(output_read, Some(&mut buf), Some(&mut read), None) };
            if ok.is_err() || read == 0 {
                break;
            }
            let data_b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..read as usize]);
            let frame = serde_json::json!({
                "type": "terminal_output",
                "session_id": session_id.to_string(),
                "data_b64": data_b64,
            })
            .to_string();
            // A full/closed queue ends this session; never wedge lifecycle teardown.
            if out_tx
                .try_send(crate::permissions::tag_message(
                    Message::Text(frame),
                    Some(generation),
                ))
                .is_err()
            {
                break;
            }
        }
        let _ = out_tx.try_send(exit_frame(session_id));
        // Drop the session if it's still registered (shell exited on its own).
        close_generation(session_id, generation);
        unsafe {
            let _ = CloseHandle(output_read);
        }
    }

    /// Create the pipes, pseudo-console and child shell. Returns
    /// `(hpcon, input_write, output_read, process, thread)`.
    unsafe fn spawn_conpty(
        cols: u16,
        rows: u16,
    ) -> windows::core::Result<(HPCON, HANDLE, HANDLE, HANDLE, HANDLE)> {
        // Pipes: agent writes input → input_write; pty reads from input_read.
        //        pty writes output → output_write; agent reads from output_read.
        let mut input_read = HANDLE::default();
        let mut input_write = HANDLE::default();
        let mut output_read = HANDLE::default();
        let mut output_write = HANDLE::default();
        CreatePipe(&mut input_read, &mut input_write, None, 0)?;
        CreatePipe(&mut output_read, &mut output_write, None, 0)?;

        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        let hpcon = CreatePseudoConsole(size, input_read, output_write, 0)?;
        // The pty owns dup'd copies now; drop our ends it doesn't need.
        let _ = CloseHandle(input_read);
        let _ = CloseHandle(output_write);

        // STARTUPINFOEX with the pseudo-console attribute.
        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;

        let mut attr_size: usize = 0;
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attr_size);
        let mut attr_buf = vec![0u8; attr_size];
        let attr = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as *mut c_void);
        InitializeProcThreadAttributeList(Some(attr), 1, None, &mut attr_size)?;
        si.lpAttributeList = attr;
        UpdateProcThreadAttribute(
            attr,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            Some(hpcon.0 as *const c_void),
            std::mem::size_of::<HPCON>(),
            None,
            None,
        )?;

        // Prefer PowerShell; the OS resolves it from PATH.
        let mut cmdline: Vec<u16> = "powershell.exe"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut pi = PROCESS_INFORMATION::default();
        let res = CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(cmdline.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT | windows::Win32::System::Threading::CREATE_SUSPENDED,
            None,
            PCWSTR::null(),
            &si.StartupInfo,
            &mut pi,
        );

        DeleteProcThreadAttributeList(attr);

        if let Err(e) = res {
            let _ = CloseHandle(input_write);
            let _ = CloseHandle(output_read);
            ClosePseudoConsole(hpcon);
            return Err(e);
        }

        Ok((hpcon, input_write, output_read, pi.hProcess, pi.hThread))
    }
}
