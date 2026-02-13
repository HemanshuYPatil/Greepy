use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

const SPEECH_TO_TEXT_DISABLED: bool = true;

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

fn push_unique_existing_dir(
    seen_dirs: &mut HashSet<String>,
    collected_dirs: &mut Vec<PathBuf>,
    candidate: PathBuf,
) {
    if !candidate.exists() || !candidate.is_dir() {
        return;
    }

    let normalized = candidate.to_string_lossy().to_string().to_lowercase();
    if seen_dirs.insert(normalized) {
        collected_dirs.push(candidate);
    }
}

fn collect_resource_search_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut seen_dirs = HashSet::new();
    let mut roots = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_unique_existing_dir(&mut seen_dirs, &mut roots, resource_dir.clone());
        push_unique_existing_dir(&mut seen_dirs, &mut roots, resource_dir.join("whisper"));
        push_unique_existing_dir(&mut seen_dirs, &mut roots, resource_dir.join("resources"));
        push_unique_existing_dir(
            &mut seen_dirs,
            &mut roots,
            resource_dir.join("resources").join("whisper"),
        );
    }

    if let Ok(executable_path) = std::env::current_exe() {
        if let Some(executable_dir) = executable_path.parent() {
            let executable_dir = executable_dir.to_path_buf();
            push_unique_existing_dir(&mut seen_dirs, &mut roots, executable_dir.clone());
            push_unique_existing_dir(&mut seen_dirs, &mut roots, executable_dir.join("whisper"));
            push_unique_existing_dir(&mut seen_dirs, &mut roots, executable_dir.join("resources"));
            push_unique_existing_dir(
                &mut seen_dirs,
                &mut roots,
                executable_dir.join("resources").join("whisper"),
            );
            push_unique_existing_dir(&mut seen_dirs, &mut roots, executable_dir.join("Resources"));
            push_unique_existing_dir(
                &mut seen_dirs,
                &mut roots,
                executable_dir.join("Resources").join("whisper"),
            );
            if let Some(parent_dir) = executable_dir.parent() {
                push_unique_existing_dir(&mut seen_dirs, &mut roots, parent_dir.join("resources"));
                push_unique_existing_dir(
                    &mut seen_dirs,
                    &mut roots,
                    parent_dir.join("resources").join("whisper"),
                );
                push_unique_existing_dir(&mut seen_dirs, &mut roots, parent_dir.join("Resources"));
                push_unique_existing_dir(
                    &mut seen_dirs,
                    &mut roots,
                    parent_dir.join("Resources").join("whisper"),
                );
            }
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        push_unique_existing_dir(
            &mut seen_dirs,
            &mut roots,
            current_dir.join("src-tauri").join("resources"),
        );
        push_unique_existing_dir(
            &mut seen_dirs,
            &mut roots,
            current_dir
                .join("src-tauri")
                .join("resources")
                .join("whisper"),
        );
    }

    roots
}

fn find_file_recursively(root: &Path, file_name: &str) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }

    let mut pending = vec![root.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }

            let matches_name = path
                .file_name()
                .and_then(|candidate| candidate.to_str())
                .map(|candidate| candidate.eq_ignore_ascii_case(file_name))
                .unwrap_or(false);
            if matches_name {
                return Some(path);
            }
        }
    }

    None
}

fn find_whisper_model_recursively(root: &Path) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }

    fn model_priority(file_name: &str) -> usize {
        match file_name {
            "ggml-large-v3.bin" => 0,
            "ggml-large-v3-turbo.bin" => 1,
            "ggml-large-v2.bin" => 2,
            "ggml-large-v1.bin" => 3,
            "ggml-large.bin" => 4,
            "ggml-medium.bin" => 5,
            "ggml-medium.en.bin" => 6,
            "ggml-small.bin" => 7,
            "ggml-small.en.bin" => 8,
            "ggml-base.bin" => 9,
            "ggml-base.en.bin" => 10,
            "ggml-tiny.bin" => 11,
            "ggml-tiny.en.bin" => 12,
            _ => 100,
        }
    }

    let mut best_match: Option<(usize, u64, PathBuf)> = None;
    let mut pending = vec![root.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }

            let is_ggml_model = path
                .file_name()
                .and_then(|candidate| candidate.to_str())
                .map(|candidate| {
                    let normalized = candidate.to_ascii_lowercase();
                    normalized.starts_with("ggml-") && normalized.ends_with(".bin")
                })
                .unwrap_or(false);
            if is_ggml_model {
                let model_name = path
                    .file_name()
                    .and_then(|candidate| candidate.to_str())
                    .map(|candidate| candidate.to_ascii_lowercase())
                    .unwrap_or_default();
                let priority = model_priority(&model_name);
                let size = fs::metadata(&path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                let should_replace = best_match
                    .as_ref()
                    .map(|(best_priority, best_size, _)| {
                        priority < *best_priority
                            || (priority == *best_priority && size > *best_size)
                    })
                    .unwrap_or(true);
                if should_replace {
                    best_match = Some((priority, size, path));
                }
            }
        }
    }

    best_match.map(|(_, _, path)| path)
}

fn resolve_bundled_resource_candidates(
    app: &tauri::AppHandle,
    relative_paths: &[&str],
    file_names: &[&str],
) -> Option<String> {
    for relative_path in relative_paths {
        if let Some(path) = resolve_bundled_resource(app, relative_path) {
            return Some(path);
        }
    }

    for root in collect_resource_search_roots(app) {
        for file_name in file_names {
            if let Some(found_path) = find_file_recursively(&root, file_name) {
                return Some(found_path.to_string_lossy().to_string());
            }
        }
    }

    None
}

fn format_exit_status(status: &std::process::ExitStatus) -> String {
    if let Some(code) = status.code() {
        #[cfg(windows)]
        {
            let code_as_u32 = code as u32;
            return format!("exit code {code} (0x{code_as_u32:08X})");
        }
        #[cfg(not(windows))]
        {
            return format!("exit code {code}");
        }
    }

    "terminated by signal".to_string()
}

fn whisper_runtime_hint(status_code: Option<i32>) -> Option<&'static str> {
    #[cfg(windows)]
    if let Some(code) = status_code {
        return match code as u32 {
            0xC0000135 => Some(
                "Windows reported STATUS_DLL_NOT_FOUND. Bundle whisper.cpp runtime DLLs (for example: whisper.dll, ggml.dll, ggml-base.dll, ggml-cpu.dll) beside whisper-cli.exe.",
            ),
            0xC000007B => Some(
                "Windows reported STATUS_INVALID_IMAGE_FORMAT. Verify Whisper binary/DLL architecture matches the app (x64 vs x86).",
            ),
            _ => None,
        };
    }

    None
}

fn is_tiny_whisper_model_path(model_path: &str) -> bool {
    Path::new(model_path)
        .file_name()
        .and_then(|candidate| candidate.to_str())
        .map(|candidate| candidate.to_ascii_lowercase().contains("ggml-tiny"))
        .unwrap_or(false)
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
        .or_else(|| {
            resolve_bundled_resource_candidates(
                app,
                &[
                    "whisper-cli.exe",
                    "whisper-cli",
                    "whisper/whisper-cli.exe",
                    "resources/whisper/whisper-cli.exe",
                    "whisper/whisper-cli",
                    "resources/whisper/whisper-cli",
                ],
                &["whisper-cli.exe", "whisper-cli"],
            )
        })
        .unwrap_or_else(|| "whisper-cli".to_string());

    let resolved_model_path = resolve_non_empty(model_path)
        .or_else(|| resolve_non_empty(std::env::var("GREEPY_WHISPER_MODEL_PATH").ok()))
        .or_else(|| {
            resolve_bundled_resource_candidates(
                app,
                &[
                    "ggml-large-v3.bin",
                    "ggml-large-v3-turbo.bin",
                    "ggml-medium.bin",
                    "ggml-medium.en.bin",
                    "ggml-base.bin",
                    "ggml-base.en.bin",
                    "ggml-tiny.en.bin",
                    "ggml-tiny.bin",
                    "whisper/ggml-large-v3.bin",
                    "resources/whisper/ggml-large-v3.bin",
                    "whisper/ggml-large-v3-turbo.bin",
                    "resources/whisper/ggml-large-v3-turbo.bin",
                    "whisper/ggml-medium.bin",
                    "resources/whisper/ggml-medium.bin",
                    "whisper/ggml-medium.en.bin",
                    "resources/whisper/ggml-medium.en.bin",
                    "whisper/ggml-base.bin",
                    "resources/whisper/ggml-base.bin",
                    "whisper/ggml-base.en.bin",
                    "resources/whisper/ggml-base.en.bin",
                    "whisper/ggml-tiny.en.bin",
                    "resources/whisper/ggml-tiny.en.bin",
                    "whisper/ggml-tiny.bin",
                    "resources/whisper/ggml-tiny.bin",
                ],
                &[
                    "ggml-large-v3.bin",
                    "ggml-large-v3-turbo.bin",
                    "ggml-large-v2.bin",
                    "ggml-large-v1.bin",
                    "ggml-large.bin",
                    "ggml-medium.bin",
                    "ggml-medium.en.bin",
                    "ggml-small.bin",
                    "ggml-small.en.bin",
                    "ggml-base.bin",
                    "ggml-base.en.bin",
                    "ggml-tiny.en.bin",
                    "ggml-tiny.bin",
                ],
            )
        })
        .or_else(|| {
            for root in collect_resource_search_roots(app) {
                if let Some(found_model) = find_whisper_model_recursively(&root) {
                    return Some(found_model.to_string_lossy().to_string());
                }
            }
            None
        })
        .ok_or_else(|| {
            "Whisper model path is missing. Set GREEPY_WHISPER_MODEL_PATH, pass modelPath, or select a larger local model file such as ggml-large-v3.bin.".to_string()
        })?;
    if is_tiny_whisper_model_path(&resolved_model_path) {
        return Err(
            "Tiny Whisper models are disabled. Select a larger model such as ggml-large-v3.bin."
                .to_string(),
        );
    }

    let resolved_language = resolve_non_empty(language)
        .or_else(|| resolve_non_empty(std::env::var("GREEPY_WHISPER_LANGUAGE").ok()))
        .unwrap_or_else(|| "auto".to_string());

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

    let mut whisper_command = Command::new(&resolved_binary);
    whisper_command
        .arg("-m")
        .arg(&resolved_model_path)
        .arg("-f")
        .arg(&input_audio_path)
        .arg("-l")
        .arg(&resolved_language)
        .arg("-otxt")
        .arg("-of")
        .arg(&output_base_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        whisper_command.creation_flags(CREATE_NO_WINDOW);
    }
    let process_output = whisper_command.output().map_err(|error| {
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
        let mut details = Vec::new();
        details.push(format!(
            "status: {}",
            format_exit_status(&process_output.status)
        ));
        if !stderr.is_empty() {
            details.push(format!("stderr: {stderr}"));
        }
        if !stdout.is_empty() {
            details.push(format!("stdout: {stdout}"));
        }
        if stderr.is_empty() && stdout.is_empty() {
            details.push("No process output captured.".to_string());
        }
        details.push(format!("binary: {resolved_binary}"));
        details.push(format!("model: {resolved_model_path}"));
        if let Some(hint) = whisper_runtime_hint(process_output.status.code()) {
            details.push(hint.to_string());
        }
        return Err(format!(
            "Whisper transcription failed: {}",
            details.join(" | ")
        ));
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
    if SPEECH_TO_TEXT_DISABLED {
        return Err("Speech-to-text is disabled in this build.".to_string());
    }
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
    if SPEECH_TO_TEXT_DISABLED {
        return Err("Speech-to-text is disabled in this build.".to_string());
    }
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
