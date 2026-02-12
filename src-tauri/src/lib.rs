use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

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

fn resolve_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn resolve_bundled_resource(app: &tauri::AppHandle, relative_path: &str) -> Option<String> {
    app.path()
        .resolve(relative_path, tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|resolved_path| resolved_path.exists())
        .map(|resolved_path| resolved_path.to_string_lossy().to_string())
}

fn whisper_transcribe_local_impl(
    app: &tauri::AppHandle,
    audio_bytes: Vec<u8>,
    whisper_binary: Option<String>,
    model_path: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    if audio_bytes.is_empty() {
        return Err("No audio payload received.".to_string());
    }

    let resolved_binary = resolve_non_empty(whisper_binary)
        .or_else(|| resolve_non_empty(std::env::var("GREEPY_WHISPER_BIN").ok()))
        .or_else(|| resolve_bundled_resource(app, "whisper/whisper-cli.exe"))
        .or_else(|| resolve_bundled_resource(app, "whisper/whisper-cli"))
        .unwrap_or_else(|| "whisper-cli".to_string());

    let resolved_model_path = resolve_non_empty(model_path)
        .or_else(|| resolve_non_empty(std::env::var("GREEPY_WHISPER_MODEL_PATH").ok()))
        .or_else(|| resolve_bundled_resource(app, "whisper/ggml-tiny.en.bin"))
        .or_else(|| resolve_bundled_resource(app, "whisper/ggml-base.en.bin"))
        .ok_or_else(|| {
            "Whisper model path is missing. Set GREEPY_WHISPER_MODEL_PATH, pass modelPath, or bundle whisper/ggml-tiny.en.bin in app resources.".to_string()
        })?;

    let resolved_language = resolve_non_empty(language)
        .or_else(|| resolve_non_empty(std::env::var("GREEPY_WHISPER_LANGUAGE").ok()))
        .unwrap_or_else(|| "en".to_string());

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let working_dir = std::env::temp_dir().join(format!("greepy-whisper-{stamp}"));
    fs::create_dir_all(&working_dir).map_err(|error| error.to_string())?;

    let input_audio_path = working_dir.join("input.wav");
    let output_base_path = working_dir.join("transcript");
    fs::write(&input_audio_path, audio_bytes).map_err(|error| {
        let _ = fs::remove_dir_all(&working_dir);
        format!("Failed to write temporary audio file: {error}")
    })?;

    let process_output = Command::new(&resolved_binary)
        .arg("-m")
        .arg(&resolved_model_path)
        .arg("-f")
        .arg(&input_audio_path)
        .arg("-l")
        .arg(&resolved_language)
        .arg("-otxt")
        .arg("-of")
        .arg(&output_base_path)
        .output()
        .map_err(|error| {
            let _ = fs::remove_dir_all(&working_dir);
            format!("Failed to launch whisper binary '{resolved_binary}': {error}")
        })?;

    if !process_output.status.success() {
        let stderr = String::from_utf8_lossy(&process_output.stderr)
            .trim()
            .to_string();
        let stdout = String::from_utf8_lossy(&process_output.stdout)
            .trim()
            .to_string();
        let _ = fs::remove_dir_all(&working_dir);
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "No process output captured.".to_string()
        };
        return Err(format!("Whisper transcription failed: {details}"));
    }

    let transcript_file = output_base_path.with_extension("txt");
    let transcript = fs::read_to_string(&transcript_file).map_err(|error| {
        let _ = fs::remove_dir_all(&working_dir);
        format!("Failed to read transcript output: {error}")
    })?;

    let _ = fs::remove_dir_all(&working_dir);
    let cleaned = transcript.trim();
    if cleaned.is_empty() {
        return Err("Transcription completed but no speech was detected.".to_string());
    }

    Ok(cleaned.to_string())
}

#[tauri::command]
fn whisper_transcribe_local(
    app: tauri::AppHandle,
    audio_bytes: Vec<u8>,
    whisper_binary: Option<String>,
    model_path: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    whisper_transcribe_local_impl(&app, audio_bytes, whisper_binary, model_path, language)
}

#[tauri::command]
fn whisper_transcribe_local_file(
    app: tauri::AppHandle,
    audio_path: String,
    whisper_binary: Option<String>,
    model_path: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    let trimmed_audio_path = audio_path.trim();
    if trimmed_audio_path.is_empty() {
        return Err("Audio file path is missing.".to_string());
    }
    let audio_bytes = fs::read(trimmed_audio_path)
        .map_err(|error| format!("Failed to read audio file '{trimmed_audio_path}': {error}"))?;
    whisper_transcribe_local_impl(&app, audio_bytes, whisper_binary, model_path, language)
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
            pty_close,
            whisper_transcribe_local,
            whisper_transcribe_local_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
