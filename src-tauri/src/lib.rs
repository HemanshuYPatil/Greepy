use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use tauri::Emitter;

struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Serialize, Clone)]
struct PtyDataPayload {
    id: String,
    data: String,
}

#[tauri::command]
fn pty_create(
    app: tauri::AppHandle,
    state: tauri::State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "lock error")?;
    if sessions.contains_key(&id) {
        return Ok(());
    }

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    #[cfg(windows)]
    let mut cmd = CommandBuilder::new("cmd.exe");
    #[cfg(windows)]
    {
        let safe_cwd = if cwd.trim().is_empty() {
            "%USERPROFILE%".to_string()
        } else {
            cwd.replace('\"', "")
        };
        cmd.arg("/Q");
        cmd.arg("/K");
        cmd.arg(format!("cd /d {}", safe_cwd));
    }

    #[cfg(not(windows))]
    let mut cmd = CommandBuilder::new("/bin/bash");

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let master = pty_pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    let id_clone = id.clone();
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&buffer[..count]).to_string();
                    let payload = PtyDataPayload {
                        id: id_clone.clone(),
                        data,
                    };
                    let _ = app_handle.emit("pty:data", payload);
                }
                Err(_) => break,
            }
        }
    });

    sessions.insert(
        id,
        Session {
            master,
            writer,
            child,
        },
    );

    Ok(())
}

#[tauri::command]
fn pty_write(state: tauri::State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "lock error")?;
    let Some(session) = sessions.get_mut(&id) else {
        return Ok(());
    };
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_resize(
    state: tauri::State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "lock error")?;
    let Some(session) = sessions.get(&id) else {
        return Ok(());
    };
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_close(state: tauri::State<PtyManager>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "lock error")?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PtyManager {
            sessions: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            pty_create,
            pty_write,
            pty_resize,
            pty_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
