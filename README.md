# Greepy

Greepy is a Tauri desktop app that launches a project-scoped terminal grid. It starts with a project folder picker and then opens one or more CMD-backed terminal panes with fast split controls.

## What the app does

- Project bootstrap screen with brand header and module cards (Terminal Grid enabled; Agent Console and Context Vault planned).
- Project folder picker (native dialog) that sets the working directory for every terminal pane.
- Multi-pane terminal grid powered by xterm.js with auto-fit and resize handling.
- Keyboard-driven splits and closure with a hard cap of 36 panes (6x6).
- Window controls for minimize, maximize/unmaximize, and close, plus F11 fullscreen toggle.

## Keyboard shortcuts

- `Ctrl+D` split horizontal (adds a new pane)
- `Ctrl+V` split vertical (adds a new pane)
- `Ctrl+W` close active pane
- `F11` toggle fullscreen

## Terminal engine

The Rust backend manages pseudo-terminals and streams data to the frontend.

- `pty_create` spawns a terminal and binds it to an id.
- `pty_write` forwards keystrokes to the PTY.
- `pty_resize` resizes the PTY on layout changes.
- `pty_close` kills the child process and tears down the session.
- PTY output is emitted as `pty:data` events and rendered into the active xterm instance.

## Platform behavior

- Windows: launches `cmd.exe` with `/Q /K` and `cd /d` into the selected project folder (or `%USERPROFILE%` when empty).
- Non-Windows: launches `/bin/bash`.

## UI and styling

- Dark, border-driven shell layout with window bar and grid lines.
- Project splash with module cards and actionable primary button.
- Merriweather is used for UI text; IBM Plex Mono stack for terminals.

## Tech stack

- Tauri 2 + Rust (portable_pty, tauri plugins: dialog, opener)
- React 19 + Vite 7 + TypeScript
- xterm.js + fit addon

## Scripts

- `pnpm dev` start Vite dev server
- `pnpm build` typecheck and build
- `pnpm preview` preview production build
- `pnpm tauri` run Tauri CLI

## Configuration notes

- Window starts maximized and uses a custom (undecorated) title bar.
- CSP is disabled in Tauri config for development.

## Local speech-to-text (Whisper)

Speech-to-text is currently disabled in this build.

Greepy supports local Whisper transcription without microphone capture:

- Use **Menu -> Transcribe Audio File**
- Select an audio file (`.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`, `.webm`)
- Transcript is inserted into the active terminal

Requirements:

- `whisper-cli` binary
- A local Whisper model file (recommended for quality: `ggml-large-v3.bin`)
- On Windows, keep Whisper runtime DLLs next to `whisper-cli.exe` when using dynamic builds (for example: `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`)

Environment variables:

- `GREEPY_WHISPER_BIN` optional custom path to Whisper CLI binary
- `GREEPY_WHISPER_MODEL_PATH` required path to local Whisper model
- `GREEPY_WHISPER_LANGUAGE` optional language code (default: `auto`)

Bundled fallback:

- If env vars are not set, the app also looks for bundled Whisper binaries:
  - `whisper/whisper-cli.exe`
- Tiny models are disabled; provide a larger local model such as `ggml-large-v3.bin`.
- GitHub release workflow populates `whisper-cli.exe` (and its runtime DLLs) before packaging.

## Auto updates (GitHub Releases)

The app is configured to check:

- `https://github.com/HemanshuYPatil/Greepy/releases/latest/download/latest.json`

When a new release is published, installed users can use **Menu -> Check for Updates** and install it in-app.

### One-time GitHub setup

Add these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: full content of your private updater key file (`~/.tauri/greepy_updater.key`)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: key password (empty string if no password)

### Publishing a new version

1. Bump `version` in `src-tauri/tauri.conf.json`.
2. Commit and push.
3. Create and push a version tag, e.g. `v0.1.1`.

The workflow in `.github/workflows/release.yml` builds and publishes a GitHub Release with signed updater artifacts (`latest.json`, signatures, and installer files).
