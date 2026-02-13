import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type PtyDataEvent = {
  id: string;
  data: string;
};

type Pane = {
  id: string;
  name: string;
};

type ShortcutSettings = {
  splitHorizontalKey: string;
  splitVerticalKey: string;
  imageDropFormat: "single-line" | "separate-lines";
};

type RecentProject = {
  path: string;
  lastOpened: number;
};

type SessionSnapshot = {
  projectPath: string;
  workspaceName?: string;
  panes: Array<{ id: string; name: string }>;
  activeId: string;
  lastSplit: "horizontal" | "vertical";
  gridLayoutId?: string;
  updatedAt: number;
};

type WorkspaceTab = {
  id: string;
  title: string;
  snapshot: SessionSnapshot | null;
};

type ServerEntry = {
  id: string;
  name: string;
  command: string;
  autostart: boolean;
};

type GridLayoutOption = {
  id: string;
  label: string;
  rows: number;
  cols: number;
};

type AgentOption = {
  id: string;
  label: string;
  defaultCommand: string;
};

type AgentAllocation = {
  enabled: boolean;
  count: number;
  command: string;
};

type WorkspaceSetupForm = {
  workspaceName: string;
  projectPath: string;
  gridLayoutId: string;
  allocations: Record<string, AgentAllocation>;
};

type WorkspaceSetupMode = "active-tab" | "new-tab";
type SettingsSection = "ui" | "appearance" | "controls" | "workspace" | "updates";
type AppTheme =
  | "carbon-black"
  | "onyx-terminal"
  | "void-slate"
  | "obsidian"
  | "neon-noir"
  | "ember-graphite"
  | "ocean-steel"
  | "forest-night";
type AppLayout =
  | "clean"
  | "compact"
  | "spacious"
  | "terminal-dense"
  | "focus-wide";
type UiPreset =
  | "default"
  | "neon-grid"
  | "ops-matrix"
  | "ocean-glass"
  | "ember-command";

type AppearanceSettings = {
  appTheme: AppTheme;
  appLayout: AppLayout;
  activityMotion: "fast" | "balanced" | "slow";
  closeButtonMode: "hover" | "always";
  uiPreset: UiPreset;
};

type UiPresetOption = {
  id: UiPreset;
  label: string;
  description: string;
  preview: string;
  theme: AppTheme;
  layout: AppLayout;
  activityMotion: AppearanceSettings["activityMotion"];
  closeButtonMode: AppearanceSettings["closeButtonMode"];
};

type WorkspacePreferences = {
  defaultWorkspaceName: string;
  defaultGridLayoutId: string;
};

type UpdaterSettings = {
  githubToken: string;
};

type SpeechCaptureState =
  | "idle"
  | "recording"
  | "transcribing"
  | "success"
  | "error";

const DEFAULT_SHORTCUTS: ShortcutSettings = {
  splitHorizontalKey: "d",
  splitVerticalKey: "b",
  imageDropFormat: "single-line",
};

const normalizeShortcutKey = (value: string) =>
  value.trim().toLowerCase().slice(0, 1);

const RECENTS_KEY = "greepy.recentProjects";
const MAX_RECENTS = 6;
const SESSION_KEY = "greepy.lastSession";
const SERVERS_KEY = "greepy.projectServers";
const LAST_PROJECT_KEY = "greepy.lastProject";
const APPEARANCE_SETTINGS_KEY = "greepy.appearanceSettings";
const WORKSPACE_PREFERENCES_KEY = "greepy.workspacePreferences";
const UPDATER_SETTINGS_KEY = "greepy.updaterSettings";
const WHISPER_MODEL_PATH_KEY = "greepy.whisperModelPath";
const WHISPER_BINARY_PATH_KEY = "greepy.whisperBinaryPath";
const SPEECH_SAMPLE_RATE = 16000;
const SPEECH_TO_TEXT_DISABLED = true;
const SPEECH_MIC_CAPTURE_DISABLED = SPEECH_TO_TEXT_DISABLED;
const SPEECH_WAVE_BAR_COUNT = 9;
const SPEECH_WAVE_IDLE_LEVEL = 0.08;
const SPEECH_WAVE_ACTIVE_FLOOR = 0.12;
const DEFAULT_GRID_LAYOUT_ID = "grid-2x2";
const GRID_LAYOUT_OPTIONS: GridLayoutOption[] = [
  { id: "grid-1", label: "1", rows: 1, cols: 1 },
  { id: "grid-1x2", label: "1x2", rows: 1, cols: 2 },
  { id: "grid-2x2", label: "2x2", rows: 2, cols: 2 },
  { id: "grid-2x3", label: "6", rows: 2, cols: 3 },
  { id: "grid-2x4", label: "8", rows: 2, cols: 4 },
  { id: "grid-2x5", label: "10", rows: 2, cols: 5 },
  { id: "grid-3x3", label: "3x3", rows: 3, cols: 3 },
  { id: "grid-4x4", label: "4x4", rows: 4, cols: 4 },
];
const AGENT_OPTIONS: AgentOption[] = [
  { id: "codex", label: "Codex", defaultCommand: "codex" },
  { id: "claude", label: "Claude", defaultCommand: "claude" },
  { id: "gemini", label: "Gemini", defaultCommand: "gemini" },
  { id: "custom", label: "Custom", defaultCommand: "" },
];

const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  appTheme: "carbon-black",
  appLayout: "clean",
  activityMotion: "fast",
  closeButtonMode: "hover",
  uiPreset: "default",
};

const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  defaultWorkspaceName: "Workspace",
  defaultGridLayoutId: DEFAULT_GRID_LAYOUT_ID,
};

const DEFAULT_UPDATER_SETTINGS: UpdaterSettings = {
  githubToken: "",
};

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  {
    id: "ui",
    label: "UI",
    description: "Switch complete app UI packs and layout direction.",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Visual behavior, activity lines, and chrome style.",
  },
  {
    id: "controls",
    label: "Controls",
    description: "Keyboard shortcuts and interaction bindings.",
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Default workspace values for quick launch.",
  },
  {
    id: "updates",
    label: "Updates",
    description: "Version status and release installation.",
  },
];

const UI_PRESET_OPTIONS: UiPresetOption[] = [
  {
    id: "default",
    label: "Default",
    description: "Balanced everyday interface with the original shell look.",
    preview: "Carbon Black + Clean layout + Fast motion",
    theme: "carbon-black",
    layout: "clean",
    activityMotion: "fast",
    closeButtonMode: "hover",
  },
  {
    id: "neon-grid",
    label: "Neon Grid",
    description: "High-contrast futuristic dashboard with wide panel spacing.",
    preview: "Neon Noir + Focus Wide + Balanced motion",
    theme: "neon-noir",
    layout: "focus-wide",
    activityMotion: "balanced",
    closeButtonMode: "always",
  },
  {
    id: "ops-matrix",
    label: "Ops Matrix",
    description: "Dense operator view made for compact, high-volume terminals.",
    preview: "Onyx Terminal + Terminal Dense + Fast motion",
    theme: "onyx-terminal",
    layout: "terminal-dense",
    activityMotion: "fast",
    closeButtonMode: "always",
  },
  {
    id: "ocean-glass",
    label: "Ocean Glass",
    description: "Calmer interface with larger spacing and softer movement.",
    preview: "Ocean Steel + Spacious + Slow motion",
    theme: "ocean-steel",
    layout: "spacious",
    activityMotion: "slow",
    closeButtonMode: "hover",
  },
  {
    id: "ember-command",
    label: "Ember Command",
    description: "Warm tactical style with compact controls and bold accents.",
    preview: "Ember Graphite + Compact + Balanced motion",
    theme: "ember-graphite",
    layout: "compact",
    activityMotion: "balanced",
    closeButtonMode: "hover",
  },
];

const getGridLayout = (id: string) =>
  GRID_LAYOUT_OPTIONS.find((option) => option.id === id) ?? GRID_LAYOUT_OPTIONS[0];

const getGridCapacity = (layout: GridLayoutOption) => layout.rows * layout.cols;

const getFolderName = (path: string) => {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
};

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "svg",
  "heic",
  "heif",
  "tif",
  "tiff",
  "avif",
  "ico",
]);

const hasImageExtension = (value: string) => {
  const clean = value.split("?")[0].split("#")[0];
  const dotIndex = clean.lastIndexOf(".");
  if (dotIndex < 0) return false;
  const extension = clean.slice(dotIndex + 1).trim().toLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
};

const isImageCandidate = (value: string, mimeType?: string) => {
  if (mimeType && mimeType.startsWith("image/")) return true;
  return hasImageExtension(value);
};

const formatDroppedPath = (path: string) => {
  if (!/\s/.test(path)) return path;
  return `"${path.replace(/"/g, '\\"')}"`;
};

const unwrapQuotedPath = (value: string) => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const extractImagePathsFromClipboardText = (value: string) => {
  const rows = value
    .split(/\r?\n/)
    .map((entry) => unwrapQuotedPath(entry))
    .filter(Boolean);
  if (!rows.length) return [];
  if (!rows.every((entry) => isImageCandidate(entry))) return [];
  return rows;
};

const buildImagePathPayload = (
  paths: string[],
  mode: ShortcutSettings["imageDropFormat"],
) => {
  const formattedPaths = paths.map(formatDroppedPath);
  if (mode === "separate-lines") return `${formattedPaths.join("\n")}\n`;
  return `${formattedPaths.join(" ")} `;
};

const toCssDropPoints = (point: { x: number; y: number }) => {
  const dpr = window.devicePixelRatio || 1;
  const candidates = [{ x: point.x, y: point.y }];
  if (Math.abs(dpr - 1) > 0.01) {
    candidates.push({ x: point.x / dpr, y: point.y / dpr });
  }
  return candidates.filter(
    (candidate) =>
      candidate.x >= 0 &&
      candidate.y >= 0 &&
      candidate.x < window.innerWidth &&
      candidate.y < window.innerHeight,
  );
};

const resolveDropTargetPaneId = (point: { x: number; y: number }) => {
  const candidates = toCssDropPoints(point);
  for (const candidate of candidates) {
    const hit = document.elementFromPoint(candidate.x, candidate.y) as HTMLElement | null;
    if (!hit) continue;
    const tile = hit.closest<HTMLElement>("[data-pane-id]");
    if (!tile) continue;
    const surface = tile.closest(".tab-surface");
    if (surface && surface.classList.contains("hidden")) continue;
    return tile.dataset.paneId ?? null;
  }
  return null;
};

const createDefaultAllocations = (): Record<string, AgentAllocation> => ({
  codex: { enabled: true, count: 2, command: "codex" },
  claude: { enabled: false, count: 0, command: "claude" },
  gemini: { enabled: false, count: 0, command: "gemini" },
  custom: { enabled: false, count: 0, command: "" },
});

const loadRecentProjects = (): RecentProject[] => {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(RECENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RecentProject[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveRecentProjects = (projects: RecentProject[]) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(RECENTS_KEY, JSON.stringify(projects));
};

const loadLastProject = (): string => {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(LAST_PROJECT_KEY) ?? "";
};

const saveLastProject = (path: string) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LAST_PROJECT_KEY, path);
};

const saveSession = (snapshot: SessionSnapshot) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
};

const loadServersMap = (): Record<string, ServerEntry[]> => {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(SERVERS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ServerEntry[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const saveServersMap = (map: Record<string, ServerEntry[]>) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SERVERS_KEY, JSON.stringify(map));
};

const isEditableTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  const tagName = element?.tagName?.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    element?.isContentEditable
  );
};

const sanitizeLog = (value: string) => {
  const withoutAnsi = value
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\]0;[^\r\n]*/g, "");
  return withoutAnsi;
};

const AGENT_STREAM_IDLE_MS = 1200;
const AGENT_BUSY_GRACE_MS = 1900;
const AGENT_RECHECK_MS = Math.max(AGENT_STREAM_IDLE_MS, AGENT_BUSY_GRACE_MS) + 120;
const AGENT_BUSY_TEXT_PATTERN = /\b(thinking|analyzing|processing|generating|executing|running)\b/i;

const hasBusySignalInChunk = (chunk: string) => {
  const normalized = sanitizeLog(chunk).toLowerCase();
  if (!normalized.trim() && !chunk.includes("\r")) return false;
  if (normalized.includes("esc to interrupt")) return true;
  if (AGENT_BUSY_TEXT_PATTERN.test(normalized)) return true;
  return chunk.includes("\r") && !chunk.includes("\n");
};

const mergeAudioChunks = (chunks: Float32Array[]) => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let nextOffset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, nextOffset);
    nextOffset += chunk.length;
  }
  return merged;
};

const downsampleAudio = (
  source: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
) => {
  if (sourceSampleRate === targetSampleRate) return source;
  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(source.length / ratio));
  const output = new Float32Array(outputLength);
  let sourceOffset = 0;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const nextSourceOffset = Math.min(
      source.length,
      Math.round((outputIndex + 1) * ratio),
    );
    let sum = 0;
    let count = 0;
    for (let sourceIndex = sourceOffset; sourceIndex < nextSourceOffset; sourceIndex += 1) {
      sum += source[sourceIndex];
      count += 1;
    }
    output[outputIndex] = count > 0 ? sum / count : 0;
    sourceOffset = nextSourceOffset;
  }

  return output;
};

const encodeWave16BitPcm = (samples: Float32Array, sampleRate: number) => {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let dataOffset = 44;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = Math.max(-1, Math.min(1, samples[sampleIndex]));
    const encoded = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(dataOffset, encoded, true);
    dataOffset += bytesPerSample;
  }

  return new Uint8Array(buffer);
};

const createSpeechWaveLevels = (value = SPEECH_WAVE_IDLE_LEVEL) =>
  Array.from({ length: SPEECH_WAVE_BAR_COUNT }, () => value);

const computeSpeechWaveLevels = (samples: Float32Array) => {
  if (samples.length === 0) return createSpeechWaveLevels();
  const levels = createSpeechWaveLevels();
  const segmentSize = Math.max(1, Math.floor(samples.length / SPEECH_WAVE_BAR_COUNT));

  for (let index = 0; index < SPEECH_WAVE_BAR_COUNT; index += 1) {
    const segmentStart = index * segmentSize;
    const segmentEnd =
      index === SPEECH_WAVE_BAR_COUNT - 1
        ? samples.length
        : Math.min(samples.length, segmentStart + segmentSize);
    if (segmentStart >= samples.length || segmentEnd <= segmentStart) {
      levels[index] = SPEECH_WAVE_IDLE_LEVEL;
      continue;
    }

    let energy = 0;
    for (let sampleIndex = segmentStart; sampleIndex < segmentEnd; sampleIndex += 1) {
      const sample = samples[sampleIndex];
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / (segmentEnd - segmentStart));
    const normalized = Math.min(1, rms * 10);
    levels[index] = Math.max(SPEECH_WAVE_ACTIVE_FLOOR, normalized);
  }

  return levels;
};

const loadShortcuts = (): ShortcutSettings => {
  if (typeof window === "undefined") return DEFAULT_SHORTCUTS;
  const raw = window.localStorage.getItem("greepy.shortcuts");
  if (!raw) return DEFAULT_SHORTCUTS;
  try {
    const parsed = JSON.parse(raw) as Partial<ShortcutSettings>;
    const splitHorizontalKey = normalizeShortcutKey(
      parsed.splitHorizontalKey ?? DEFAULT_SHORTCUTS.splitHorizontalKey,
    );
    const splitVerticalKey = normalizeShortcutKey(
      parsed.splitVerticalKey ?? DEFAULT_SHORTCUTS.splitVerticalKey,
    );
    const imageDropFormat =
      parsed.imageDropFormat === "separate-lines" ||
      parsed.imageDropFormat === "single-line"
        ? parsed.imageDropFormat
        : DEFAULT_SHORTCUTS.imageDropFormat;
    if (!splitHorizontalKey || !splitVerticalKey) return DEFAULT_SHORTCUTS;
    return { splitHorizontalKey, splitVerticalKey, imageDropFormat };
  } catch {
    return DEFAULT_SHORTCUTS;
  }
};

const saveShortcuts = (shortcuts: ShortcutSettings) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("greepy.shortcuts", JSON.stringify(shortcuts));
};

const loadAppearanceSettings = (): AppearanceSettings => {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE_SETTINGS;
  const raw = window.localStorage.getItem(APPEARANCE_SETTINGS_KEY);
  if (!raw) return DEFAULT_APPEARANCE_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    const appTheme =
      parsed.appTheme === "carbon-black" ||
      parsed.appTheme === "onyx-terminal" ||
      parsed.appTheme === "void-slate" ||
      parsed.appTheme === "obsidian" ||
      parsed.appTheme === "neon-noir" ||
      parsed.appTheme === "ember-graphite" ||
      parsed.appTheme === "ocean-steel" ||
      parsed.appTheme === "forest-night"
        ? parsed.appTheme
        : DEFAULT_APPEARANCE_SETTINGS.appTheme;
    const appLayout =
      parsed.appLayout === "terminal-dense" ||
      parsed.appLayout === "focus-wide" ||
      parsed.appLayout === "compact" ||
      parsed.appLayout === "spacious" ||
      parsed.appLayout === "clean"
        ? parsed.appLayout
        : DEFAULT_APPEARANCE_SETTINGS.appLayout;
    const activityMotion =
      parsed.activityMotion === "slow" ||
      parsed.activityMotion === "balanced" ||
      parsed.activityMotion === "fast"
        ? parsed.activityMotion
        : DEFAULT_APPEARANCE_SETTINGS.activityMotion;
    const closeButtonMode =
      parsed.closeButtonMode === "always" || parsed.closeButtonMode === "hover"
        ? parsed.closeButtonMode
        : DEFAULT_APPEARANCE_SETTINGS.closeButtonMode;
    const uiPreset =
      parsed.uiPreset === "default" ||
      parsed.uiPreset === "neon-grid" ||
      parsed.uiPreset === "ops-matrix" ||
      parsed.uiPreset === "ocean-glass" ||
      parsed.uiPreset === "ember-command"
        ? parsed.uiPreset
        : DEFAULT_APPEARANCE_SETTINGS.uiPreset;
    return { appTheme, appLayout, activityMotion, closeButtonMode, uiPreset };
  } catch {
    return DEFAULT_APPEARANCE_SETTINGS;
  }
};

const saveAppearanceSettings = (settings: AppearanceSettings) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(APPEARANCE_SETTINGS_KEY, JSON.stringify(settings));
};

const loadWorkspacePreferences = (): WorkspacePreferences => {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_PREFERENCES;
  const raw = window.localStorage.getItem(WORKSPACE_PREFERENCES_KEY);
  if (!raw) return DEFAULT_WORKSPACE_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspacePreferences>;
    const hasValidGridLayout =
      typeof parsed.defaultGridLayoutId === "string" &&
      GRID_LAYOUT_OPTIONS.some((option) => option.id === parsed.defaultGridLayoutId);
    return {
      defaultWorkspaceName:
        typeof parsed.defaultWorkspaceName === "string" &&
        parsed.defaultWorkspaceName.trim()
          ? parsed.defaultWorkspaceName
          : DEFAULT_WORKSPACE_PREFERENCES.defaultWorkspaceName,
      defaultGridLayoutId: hasValidGridLayout
        ? parsed.defaultGridLayoutId!
        : DEFAULT_WORKSPACE_PREFERENCES.defaultGridLayoutId,
    };
  } catch {
    return DEFAULT_WORKSPACE_PREFERENCES;
  }
};

const saveWorkspacePreferences = (preferences: WorkspacePreferences) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    WORKSPACE_PREFERENCES_KEY,
    JSON.stringify(preferences),
  );
};

const loadUpdaterSettings = (): UpdaterSettings => {
  if (typeof window === "undefined") return DEFAULT_UPDATER_SETTINGS;
  const raw = window.localStorage.getItem(UPDATER_SETTINGS_KEY);
  if (!raw) return DEFAULT_UPDATER_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<UpdaterSettings>;
    return {
      githubToken:
        typeof parsed.githubToken === "string" ? parsed.githubToken : "",
    };
  } catch {
    return DEFAULT_UPDATER_SETTINGS;
  }
};

const loadStoredWhisperPath = (key: string): string => {
  if (typeof window === "undefined") return "";
  try {
    const value = window.localStorage.getItem(key);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
};

const saveStoredWhisperPath = (key: string, value: string) => {
  if (typeof window === "undefined") return;
  const trimmed = value.trim();
  if (!trimmed) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, trimmed);
};

const formatErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

let ptyCreateQueue: Promise<void> = Promise.resolve();
const startupCommandExecuted = new Set<string>();

const enqueuePtyCreate = (task: () => Promise<void>) => {
  const next = ptyCreateQueue.then(task, task);
  ptyCreateQueue = next.catch(() => undefined);
  return next;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_SPLITS = 6;

const createRuntimeId = (prefix: string) =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

const ACTIVITY_VARIANT_COUNT = 25;

type ActivityPalette = {
  primaryGradient: string;
  secondaryGradient: string;
  primaryGlowSoft: string;
  primaryGlowStrong: string;
  secondaryGlowSoft: string;
  secondaryGlowStrong: string;
};

const createActivityPalette = (variant: number): ActivityPalette => {
  const hueA = (variant * 29 + 16) % 360;
  const hueB = (hueA + 32 + (variant % 4) * 8) % 360;
  const hueC = (hueA + 78 + (variant % 5) * 6) % 360;
  const hueD = (hueA + 138 + (variant % 3) * 9) % 360;
  const hueE = (hueA + 202 + (variant % 7) * 4) % 360;

  return {
    primaryGradient: `linear-gradient(90deg, transparent 0%, hsla(${hueA}, 92%, 58%, 0.08) 6%, hsla(${hueB}, 96%, 63%, 0.56) 24%, hsla(${hueC}, 100%, 70%, 0.98) 43%, hsla(${hueD}, 98%, 67%, 1) 57%, hsla(${hueB}, 92%, 60%, 0.62) 78%, hsla(${hueE}, 86%, 56%, 0.12) 94%, transparent 100%)`,
    secondaryGradient: `linear-gradient(90deg, transparent 0%, hsla(${hueE}, 86%, 56%, 0.06) 4%, hsla(${hueC}, 98%, 66%, 0.36) 26%, hsla(${hueD}, 92%, 63%, 0.9) 50%, hsla(${hueB}, 98%, 68%, 0.36) 74%, hsla(${hueA}, 86%, 58%, 0.08) 96%, transparent 100%)`,
    primaryGlowSoft: `hsla(${hueC}, 100%, 72%, 0.72)`,
    primaryGlowStrong: `hsla(${hueD}, 94%, 62%, 0.46)`,
    secondaryGlowSoft: `hsla(${hueB}, 100%, 72%, 0.56)`,
    secondaryGlowStrong: `hsla(${hueA}, 90%, 60%, 0.34)`,
  };
};

const createPane = (index: number): Pane => ({
  id: createRuntimeId("pane"),
  name: `Terminal ${index}`,
});

type TerminalPaneProps = {
  id: string;
  activityVariant: number;
  layoutTick: number;
  isActive: boolean;
  isDropTarget: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  canClose: boolean;
  cwd: string;
  startupCommand?: string;
  onStartupCommandConsumed: (id: string) => void;
};

function TerminalPane({
  id,
  activityVariant,
  layoutTick,
  isActive,
  isDropTarget,
  onSelect,
  onClose,
  canClose,
  cwd,
  startupCommand,
  onStartupCommandConsumed,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const isWorkingRef = useRef(false);
  const awaitingResponseRef = useRef(false);
  const lastOutputAtRef = useRef(0);
  const lastBusySignalAtRef = useRef(0);
  const signalSyncRafRef = useRef<number | null>(null);
  const signalSyncTimeoutRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAgentWorking, setIsAgentWorking] = useState(false);
  const lastInsertRef = useRef<{ payload: string; at: number }>({ payload: "", at: 0 });
  const activityPalette = useMemo(() => createActivityPalette(activityVariant), [activityVariant]);
  const activityVariantStyle = useMemo(
    () =>
      ({
        "--activity-primary-gradient": activityPalette.primaryGradient,
        "--activity-secondary-gradient": activityPalette.secondaryGradient,
        "--activity-primary-glow-soft": activityPalette.primaryGlowSoft,
        "--activity-primary-glow-strong": activityPalette.primaryGlowStrong,
        "--activity-secondary-glow-soft": activityPalette.secondaryGlowSoft,
        "--activity-secondary-glow-strong": activityPalette.secondaryGlowStrong,
      }) as Record<string, string>,
    [activityPalette],
  );

  const handleTileClick = () => {
    onSelect(id);
    termRef.current?.focus();
  };

  const setWorkingState = (next: boolean) => {
    if (isWorkingRef.current === next) return;
    isWorkingRef.current = next;
    setIsAgentWorking(next);
  };

  const writeDedupedPayload = (payload: string) => {
    const now = Date.now();
    if (
      lastInsertRef.current.payload === payload &&
      now - lastInsertRef.current.at < 280
    ) {
      return;
    }
    lastInsertRef.current = { payload, at: now };
    void invoke("pty_write", { id, data: payload });
  };

  const hasInterruptSignal = () => {
    const term = termRef.current;
    if (!term) return false;

    const buffer = term.buffer.active;
    const marker = "esc to interrupt";
    const viewportStart = Math.max(0, buffer.viewportY - 1);
    const viewportEnd = Math.min(buffer.length - 1, buffer.viewportY + term.rows + 1);
    const visibleText: string[] = [];

    for (let lineIndex = viewportStart; lineIndex <= viewportEnd; lineIndex += 1) {
      const line = buffer.getLine(lineIndex)?.translateToString(true).toLowerCase() ?? "";
      if (line.includes(marker)) return true;
      visibleText.push(line);
    }

    // Covers wrapped markers split across two visible lines.
    return visibleText.join(" ").includes(marker);
  };

  const syncWorkingFromTerminal = () => {
    const now = Date.now();
    const hasInterruptMarker = hasInterruptSignal();
    const hasRecentBusySignal = now - lastBusySignalAtRef.current < AGENT_BUSY_GRACE_MS;
    const hasRecentOutput =
      awaitingResponseRef.current && now - lastOutputAtRef.current < AGENT_STREAM_IDLE_MS;

    if (!hasInterruptMarker && awaitingResponseRef.current && !hasRecentOutput) {
      awaitingResponseRef.current = false;
    }

    setWorkingState(hasInterruptMarker || hasRecentBusySignal || hasRecentOutput);
  };

  const scheduleSignalSync = () => {
    if (signalSyncRafRef.current !== null) return;
    signalSyncRafRef.current = window.requestAnimationFrame(() => {
      signalSyncRafRef.current = null;
      syncWorkingFromTerminal();
    });
  };

  const scheduleDelayedSignalSync = () => {
    if (signalSyncTimeoutRef.current !== null) {
      window.clearTimeout(signalSyncTimeoutRef.current);
    }
    signalSyncTimeoutRef.current = window.setTimeout(() => {
      signalSyncTimeoutRef.current = null;
      syncWorkingFromTerminal();
    }, AGENT_RECHECK_MS);
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let windowResizeHandler: (() => void) | null = null;
    let pasteHandler: ((event: ClipboardEvent) => void) | null = null;
    let disposed = false;

    const setup = async () => {
      if (!containerRef.current) return;
      const container = containerRef.current;

      const term = new Terminal({
        fontFamily:
          "IBM Plex Mono, SFMono-Regular, Consolas, Liberation Mono, monospace",
        fontSize: 13,
        cursorBlink: true,
        theme: {
          background: "#0b0b0b",
          foreground: "#f2f2f2",
          selectionBackground: "#2b2b2b",
          cursor: "#f2f2f2",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      requestAnimationFrame(() => {
        fitAddon.fit();
      });

      term.attachCustomKeyEventHandler((event) => {
        if (event.ctrlKey) {
          const key = event.key.toLowerCase();
          if (key === "d" || key === "w" || key === "v") return false;
        }
        return true;
      });

      termRef.current = term;
      fitRef.current = fitAddon;

      const createWithRetry = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await invoke("pty_create", {
              id,
              cols: term.cols,
              rows: term.rows,
              cwd,
            });
            return;
          } catch (err) {
            if (attempt === 2) throw err;
            await delay(150);
          }
        }
      };

      try {
        await enqueuePtyCreate(createWithRetry);
      } catch (err) {
        setError("Terminal failed to start");
        setIsLoading(false);
        return;
      }

      if (startupCommand?.trim() && !startupCommandExecuted.has(id)) {
        startupCommandExecuted.add(id);
        try {
          await invoke("pty_write", { id, data: `${startupCommand.trim()}\r` });
        } catch {
          // Ignore startup command failures; terminal remains usable.
        } finally {
          onStartupCommandConsumed(id);
        }
      }

      const loadingTimeout = window.setTimeout(() => {
        setIsLoading(false);
      }, 1200);

      term.onData((data) => {
        void invoke("pty_write", { id, data });
        const now = Date.now();
        if (data.includes("\u0003")) {
          awaitingResponseRef.current = false;
          lastBusySignalAtRef.current = 0;
        } else if (data.includes("\r")) {
          awaitingResponseRef.current = true;
          lastOutputAtRef.current = now;
        }

        scheduleSignalSync();
        scheduleDelayedSignalSync();
      });

      pasteHandler = (event: ClipboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const writeClipboardText = async (text: string) => {
            const imagePaths = extractImagePathsFromClipboardText(text);
            if (imagePaths.length > 0) {
              // Always use single-image style for multi-image paste.
              writeDedupedPayload(buildImagePathPayload(imagePaths, "single-line"));
              return;
            }
            writeDedupedPayload(text);
          };

          try {
            const text = await readClipboardText();
            if (text) {
              await writeClipboardText(text);
            }
          } catch {
            const text = event.clipboardData?.getData("text");
            if (!text) return;
            await writeClipboardText(text);
          }
        })();
      };

      container.addEventListener("paste", pasteHandler);

      unlisten = await listen<PtyDataEvent>("pty:data", (event) => {
        if (event.payload.id === id) {
          setIsLoading(false);
          term.write(event.payload.data);
          const now = Date.now();
          lastOutputAtRef.current = now;
          if (hasBusySignalInChunk(event.payload.data)) {
            lastBusySignalAtRef.current = now;
          }
          scheduleDelayedSignalSync();
          scheduleSignalSync();
        }
      });

      const handleResize = () => {
        fitAddon.fit();
        void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
      };

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(container);
      } else {
        windowResizeHandler = handleResize;
        window.addEventListener("resize", windowResizeHandler);
      }

      handleResize();

      if (disposed) {
        term.dispose();
      }

      return () => window.clearTimeout(loadingTimeout);
    };

    void setup();

    return () => {
      disposed = true;
      if (resizeObserver && containerRef.current) {
        resizeObserver.unobserve(containerRef.current);
      }
      if (windowResizeHandler) {
        window.removeEventListener("resize", windowResizeHandler);
      }
      if (unlisten) unlisten();
      if (pasteHandler && containerRef.current) {
        containerRef.current.removeEventListener("paste", pasteHandler);
      }
      if (signalSyncRafRef.current !== null) {
        window.cancelAnimationFrame(signalSyncRafRef.current);
        signalSyncRafRef.current = null;
      }
      if (signalSyncTimeoutRef.current !== null) {
        window.clearTimeout(signalSyncTimeoutRef.current);
        signalSyncTimeoutRef.current = null;
      }
      if (termRef.current) termRef.current.dispose();
      termRef.current = null;
      fitRef.current = null;
      awaitingResponseRef.current = false;
      lastOutputAtRef.current = 0;
      lastBusySignalAtRef.current = 0;
      lastInsertRef.current = { payload: "", at: 0 };
      setWorkingState(false);
      void invoke("pty_close", { id });
    };
  }, [id, cwd]);

  useEffect(() => {
    if (isActive) {
      termRef.current?.focus();
    }
  }, [isActive]);

  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    const fitNow = () => {
      fitRef.current?.fit();
      void invoke("pty_resize", {
        id,
        cols: termRef.current?.cols ?? 80,
        rows: termRef.current?.rows ?? 24,
      });
    };
    const raf = requestAnimationFrame(() => {
      fitNow();
      setTimeout(fitNow, 80);
    });
    return () => cancelAnimationFrame(raf);
  }, [layoutTick, id]);

  return (
    <div
      className={`tile ${isActive ? "active" : ""} ${isDropTarget ? "drop-target" : ""}`}
      data-pane-id={id}
      onClick={handleTileClick}
    >
      <div className="tile-status-bar">
        <div className={`tile-activity ${isAgentWorking ? "working" : ""}`} style={activityVariantStyle as any}>
          <span className="activity-wave" />
          <span className="activity-wave secondary" />
        </div>
        <button
          className="tile-close-btn"
          onClick={(event) => {
            event.stopPropagation();
            onClose(id);
          }}
          disabled={!canClose}
          title={canClose ? "Close terminal" : "At least one terminal required"}
          aria-label="Close terminal"
        >
          <svg className="tile-close-icon" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2 L10 10" />
            <path d="M10 2 L2 10" />
          </svg>
        </button>
      </div>
      {isLoading && !error && (
        <div className="terminal-loading">
          <div className="loader" />
          <span>Starting terminal…</span>
        </div>
      )}
      {error && (
        <div className="terminal-loading">
          <span>{error}</span>
        </div>
      )}
      <div className="terminal-shell-wrap">
        <div className="terminal-shell" ref={containerRef} />
        <div className={`terminal-drop-overlay ${isDropTarget ? "visible" : ""}`} aria-hidden="true">
          <div className="terminal-drop-overlay-inner">
            <span className="terminal-drop-overlay-title">Drop Images Here</span>
            <span className="terminal-drop-overlay-subtitle">Only this terminal receives the paste</span>
          </div>
        </div>
      </div>
    </div>
  );
}

type ServerManagerProps = {
  embedded?: boolean;
};

function ServerManager({ embedded = false }: ServerManagerProps) {
  const [projectPath, setProjectPath] = useState(() => loadLastProject());
  const [servers, setServers] = useState<ServerEntry[]>(() => {
    const map = loadServersMap();
    return map[projectPath] ?? [];
  });
  const [runState, setRunState] = useState<
    Record<string, { ptyId: string; output: string; running: boolean }>
  >({});
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const ptyToServerRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const setup = async () => {
      unlisten = await listen<PtyDataEvent>("pty:data", (event) => {
        const serverId = ptyToServerRef.current[event.payload.id];
        if (!serverId) return;
        setRunState((current) => {
          const prev =
            current[serverId] ?? {
              ptyId: event.payload.id,
              output: "",
              running: true,
            };
          const output = sanitizeLog(
            `${prev.output}${event.payload.data}`,
          ).slice(-10000);
          return {
            ...current,
            [serverId]: { ...prev, output },
          };
        });
      });
    };
    void setup();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const map = loadServersMap();
    setServers(map[projectPath] ?? []);
    const next = map[projectPath]?.[0]?.id ?? null;
    setSelectedServerId(next);
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) return;
    const map = loadServersMap();
    map[projectPath] = servers;
    saveServersMap(map);
  }, [servers, projectPath]);

  const startServer = async (server: ServerEntry) => {
    if (!projectPath) return;
    if (runState[server.id]?.running) return;
    if (!server.command.trim()) return;
    const ptyId = `srv-${server.id}-${Date.now()}`;
    ptyToServerRef.current[ptyId] = server.id;
    setRunState((current) => ({
      ...current,
      [server.id]: { ptyId, output: current[server.id]?.output ?? "", running: true },
    }));
    await invoke("pty_create", { id: ptyId, cols: 120, rows: 30, cwd: projectPath });
    await invoke("pty_write", { id: ptyId, data: `${server.command}\r` });
    setSelectedServerId(server.id);
  };

  const stopServer = async (server: ServerEntry) => {
    const run = runState[server.id];
    if (!run?.ptyId) return;
    await invoke("pty_close", { id: run.ptyId });
    setRunState((current) => ({
      ...current,
      [server.id]: { ...run, running: false },
    }));
  };

  useEffect(() => {
    servers.forEach((server) => {
      if (server.autostart && !runState[server.id]?.running) {
        void startServer(server);
      }
    });
  }, [servers, projectPath, runState]);

  const updateServer = (index: number, next: Partial<ServerEntry>) => {
    setServers((current) => {
      const updated = [...current];
      updated[index] = { ...updated[index], ...next };
      return updated;
    });
  };

  const addServer = () => {
    setServers((current) => [
      ...current,
      {
        id: `srv-${Date.now()}`,
        name: "New server",
        command: "",
        autostart: false,
      },
    ]);
  };

  const removeServer = (id: string) => {
    setServers((current) => current.filter((server) => server.id !== id));
  };

  const handleChooseProject = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Project Folder",
    });
    if (typeof selected === "string" && selected.trim()) {
      const path = selected.trim();
      setProjectPath(path);
      saveLastProject(path);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="server-topbar">
          <div className="server-topbar-text">
            <div className="server-topbar-title">Server Manager</div>
            <div className="server-topbar-path">
              {projectPath || "No project selected"}
            </div>
          </div>
          <div className="server-topbar-actions">
            <button className="btn secondary" onClick={handleChooseProject}>
              Change Project
            </button>
          </div>
        </div>
      </header>

      <div className={`server-shell ${embedded ? "embedded" : ""}`}>
        <div className="server-header">
          <div>
            <div className="server-title">Servers</div>
            <div className="server-subtitle">
              Manage long-running commands for this project.
            </div>
          </div>
          <button className="btn secondary" onClick={addServer}>
            Add server
          </button>
        </div>
        <div className="server-list">
          {servers.length === 0 && (
            <div className="server-empty">No servers yet.</div>
          )}
          {servers.map((server, index) => {
            const running = runState[server.id]?.running ?? false;
            return (
              <div
                className={`server-card ${
                  selectedServerId === server.id ? "selected" : ""
                }`}
                key={server.id}
                onClick={() => setSelectedServerId(server.id)}
              >
                <div className="server-card-header">
                  <div className="server-title-row">
                    <input
                      value={server.name}
                      placeholder="Server name"
                      onChange={(event) =>
                        updateServer(index, { name: event.target.value })
                      }
                    />
                    <span className={`server-status ${running ? "on" : "off"}`}>
                      {running ? "Running" : "Stopped"}
                    </span>
                  </div>
                  <div className="server-command-row">
                    <input
                      value={server.command}
                      placeholder="Command (e.g. pnpm dev)"
                      onChange={(event) =>
                        updateServer(index, { command: event.target.value })
                      }
                    />
                  </div>
                  <div className="server-controls">
                    <label className="server-toggle">
                      <input
                        type="checkbox"
                        checked={server.autostart}
                        onChange={(event) =>
                          updateServer(index, { autostart: event.target.checked })
                        }
                      />
                      Autostart
                    </label>
                    <div className="server-actions">
                      {running ? (
                        <button
                          className="btn primary tone-stop"
                          onClick={() => void stopServer(server)}
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          className="btn primary"
                          onClick={() => void startServer(server)}
                          disabled={!server.command.trim()}
                        >
                          Start
                        </button>
                      )}
                      <button
                        className="btn primary tone-remove"
                        onClick={() => removeServer(server.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="server-log-panel">
          <div className="server-log-header">
            Logs
            {selectedServerId && (
              <span className="server-log-title">
                {servers.find((server) => server.id === selectedServerId)?.name ??
                  "Server"}
              </span>
            )}
          </div>
          <pre className="server-log">
            {selectedServerId
              ? runState[selectedServerId]?.output ?? "No output yet."
              : "Select a server to view logs."}
          </pre>
        </div>
      </div>
    </div>
  );
}

function MainApp() {
  const [panes, setPanes] = useState<Pane[]>(() => [createPane(1)]);
  const [activeId, setActiveId] = useState<string>(() => panes[0].id);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => {
    const id = createRuntimeId("tab");
    return [{ id, title: "Tab 1", snapshot: null }];
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [layoutTick, setLayoutTick] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [workspacePreferences, setWorkspacePreferences] = useState<WorkspacePreferences>(
    () => loadWorkspacePreferences(),
  );
  const [workspaceName, setWorkspaceName] = useState(
    workspacePreferences.defaultWorkspaceName,
  );
  const [fixedGridLayoutId, setFixedGridLayoutId] = useState<string | null>(null);
  const [startupCommands, setStartupCommands] = useState<Record<string, string>>({});
  const [isProjectReady, setIsProjectReady] = useState(false);
  const [isWorkspaceSetupOpen, setIsWorkspaceSetupOpen] = useState(false);
  const [workspaceSetupMode, setWorkspaceSetupMode] =
    useState<WorkspaceSetupMode>("active-tab");
  const [workspaceSetupError, setWorkspaceSetupError] = useState<string | null>(null);
  const [workspaceSetupForm, setWorkspaceSetupForm] = useState<WorkspaceSetupForm>({
    workspaceName: workspacePreferences.defaultWorkspaceName,
    projectPath: loadLastProject(),
    gridLayoutId: workspacePreferences.defaultGridLayoutId,
    allocations: createDefaultAllocations(),
  });
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() =>
    loadRecentProjects(),
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [isServersInline, setIsServersInline] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [availableUpdateVersion, setAvailableUpdateVersion] = useState<string | null>(
    null,
  );
  const [appearanceSettings, setAppearanceSettings] = useState<AppearanceSettings>(
    () => loadAppearanceSettings(),
  );
  const [draftAppearanceSettings, setDraftAppearanceSettings] =
    useState<AppearanceSettings>(appearanceSettings);
  const [draftWorkspacePreferences, setDraftWorkspacePreferences] =
    useState<WorkspacePreferences>(workspacePreferences);
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<SettingsSection>("controls");
  const [updaterSettings] = useState<UpdaterSettings>(() => loadUpdaterSettings());
  const [shortcuts, setShortcuts] = useState<ShortcutSettings>(() =>
    loadShortcuts(),
  );
  const [draftShortcuts, setDraftShortcuts] = useState<ShortcutSettings>(
    shortcuts,
  );
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [speechCaptureState, setSpeechCaptureState] =
    useState<SpeechCaptureState>("idle");
  const [isSpeechCtrlHeld, setIsSpeechCtrlHeld] = useState(false);
  const [speechWaveLevels, setSpeechWaveLevels] = useState<number[]>(() =>
    createSpeechWaveLevels(),
  );
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const [isImageDragActive, setIsImageDragActive] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dropImageActiveRef = useRef(false);
  const whisperModelPathRef = useRef(loadStoredWhisperPath(WHISPER_MODEL_PATH_KEY));
  const whisperBinaryPathRef = useRef(loadStoredWhisperPath(WHISPER_BINARY_PATH_KEY));
  const speechStreamRef = useRef<MediaStream | null>(null);
  const speechAudioContextRef = useRef<AudioContext | null>(null);
  const speechSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const speechProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const speechSilenceRef = useRef<GainNode | null>(null);
  const speechChunksRef = useRef<Float32Array[]>([]);
  const speechSampleRateRef = useRef(SPEECH_SAMPLE_RATE);
  const speechRecordingRef = useRef(false);
  const speechCtrlPressedRef = useRef(false);
  const speechCtrlChordRef = useRef(false);
  const speechStartInFlightRef = useRef(false);
  const speechStartTokenRef = useRef(0);
  const speechStopRequestedRef = useRef(false);
  const lastGlobalDropRef = useRef<{ paneId: string; payload: string; at: number } | null>(
    null,
  );
  const [lastSplit, setLastSplit] = useState<"horizontal" | "vertical">(
    "horizontal",
  );
  const appWindow = useMemo(() => getCurrentWindow(), []);

  useEffect(() => {
    void appWindow.maximize();
  }, [appWindow]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      setIsMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isMenuOpen]);

  useEffect(() => {
    let unlistenDragDrop: (() => void) | null = null;
    const writeDroppedImages = (paneId: string, imagePaths: string[]) => {
      const payload = buildImagePathPayload(imagePaths, shortcuts.imageDropFormat);
      const now = Date.now();
      const previous = lastGlobalDropRef.current;
      if (
        previous &&
        previous.paneId === paneId &&
        previous.payload === payload &&
        now - previous.at < 280
      ) {
        return;
      }
      lastGlobalDropRef.current = { paneId, payload, at: now };
      setActiveId(paneId);
      void invoke("pty_write", { id: paneId, data: payload });
    };

    const setup = async () => {
      unlistenDragDrop = await appWindow.onDragDropEvent((event) => {
        const payload = event.payload;
        const targetPaneId =
          payload.type === "leave" ? null : resolveDropTargetPaneId(payload.position);

        if (payload.type === "leave") {
          dropImageActiveRef.current = false;
          setIsImageDragActive(false);
          setDropTargetPaneId(null);
          return;
        }

        if (payload.type === "enter") {
          const hasImage = payload.paths.some((path) => isImageCandidate(path));
          dropImageActiveRef.current = hasImage;
          setIsImageDragActive(hasImage);
          setDropTargetPaneId(hasImage ? targetPaneId : null);
          return;
        }

        if (payload.type === "over") {
          setDropTargetPaneId(dropImageActiveRef.current ? targetPaneId : null);
          return;
        }

        if (payload.type === "drop") {
          const imagePaths = payload.paths.filter((path) => isImageCandidate(path));
          dropImageActiveRef.current = false;
          setIsImageDragActive(false);
          setDropTargetPaneId(null);
          if (!targetPaneId || !imagePaths.length) return;
          writeDroppedImages(targetPaneId, imagePaths);
        }
      });
    };

    void setup();
    return () => {
      if (unlistenDragDrop) unlistenDragDrop();
      dropImageActiveRef.current = false;
      setIsImageDragActive(false);
      setDropTargetPaneId(null);
    };
  }, [appWindow, shortcuts.imageDropFormat]);

  const buildSnapshot = (
    nextProjectPath: string,
    nextWorkspaceName: string,
    nextPanes: Pane[],
    nextActiveId: string,
    nextLastSplit: "horizontal" | "vertical",
    nextGridLayoutId: string | null,
  ): SessionSnapshot | null => {
    if (!nextProjectPath.trim() || nextPanes.length === 0) return null;
    return {
      projectPath: nextProjectPath,
      workspaceName: nextWorkspaceName,
      panes: nextPanes.map((pane) => ({ id: pane.id, name: pane.name })),
      activeId: nextActiveId,
      lastSplit: nextLastSplit,
      gridLayoutId: nextGridLayoutId ?? undefined,
      updatedAt: Date.now(),
    };
  };

  useEffect(() => {
    if (!activeTabId) return;
    const snapshot = isProjectReady
      ? buildSnapshot(
          projectPath,
          workspaceName,
          panes,
          activeId,
          lastSplit,
          fixedGridLayoutId,
        )
      : null;
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId
          ? {
              ...tab,
              snapshot,
            }
          : tab,
      ),
    );
  }, [
    activeTabId,
    isProjectReady,
    projectPath,
    workspaceName,
    panes,
    activeId,
    lastSplit,
    fixedGridLayoutId,
  ]);

  const loadTabRuntime = (target: WorkspaceTab) => {
    startupCommandExecuted.clear();
    setStartupCommands({});

    if (target.snapshot) {
      const snapshot = target.snapshot;
      setProjectPath(snapshot.projectPath);
      setWorkspaceName(
        snapshot.workspaceName?.trim() ||
          getFolderName(snapshot.projectPath) ||
          target.title,
      );
      setIsProjectReady(true);
      setPanes(
        snapshot.panes.map((pane, index) => ({
          id: pane.id,
          name: pane.name || `Terminal ${index + 1}`,
        })),
      );
      setActiveId(
        snapshot.panes.some((pane) => pane.id === snapshot.activeId)
          ? snapshot.activeId
          : snapshot.panes[0].id,
      );
      setLastSplit(snapshot.lastSplit ?? "horizontal");
      setFixedGridLayoutId(snapshot.gridLayoutId ?? null);
      setWorkspaceSetupForm((current) => ({
        ...current,
        workspaceName:
          snapshot.workspaceName?.trim() ||
          getFolderName(snapshot.projectPath) ||
          target.title,
        projectPath: snapshot.projectPath,
        gridLayoutId: snapshot.gridLayoutId ?? current.gridLayoutId,
      }));
      setLayoutTick((tick) => tick + 1);
      return;
    }

    const pane = createPane(1);
    setProjectPath("");
    setWorkspaceName(target.title);
    setIsProjectReady(false);
    setPanes([pane]);
    setActiveId(pane.id);
    setLastSplit("horizontal");
    setFixedGridLayoutId(null);
    setWorkspaceSetupForm((current) => ({
      ...current,
      workspaceName: target.title,
      projectPath: loadLastProject(),
    }));
    setLayoutTick((tick) => tick + 1);
  };

  const handleSelectTab = (tabId: string) => {
    if (tabId === activeTabId) return;
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target) return;

    const currentSnapshot = isProjectReady
      ? buildSnapshot(
          projectPath,
          workspaceName,
          panes,
          activeId,
          lastSplit,
          fixedGridLayoutId,
        )
      : null;
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId
          ? {
              ...tab,
              snapshot: currentSnapshot,
            }
          : tab,
      ),
    );

    setActiveTabId(tabId);
    setIsMenuOpen(false);
    loadTabRuntime(target);
  };

  const handleRenameTab = (tabId: string) => {
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target || typeof window === "undefined") return;
    const next = window.prompt("Rename tab", target.title)?.trim();
    if (!next) return;
    setTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, title: next } : tab)),
    );
    if (tabId === activeTabId && !isProjectReady) {
      setWorkspaceName(next);
      setWorkspaceSetupForm((current) => ({ ...current, workspaceName: next }));
    }
    setIsMenuOpen(false);
  };

  const handleDeleteTab = (tabId: string) => {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const filtered = tabs.filter((tab) => tab.id !== tabId);
    const fallback =
      filtered[Math.max(0, index - 1)] ?? filtered[0] ?? null;

    setTabs(filtered);
    if (tabId !== activeTabId || !fallback) {
      setIsMenuOpen(false);
      return;
    }

    setActiveTabId(fallback.id);
    loadTabRuntime(fallback);
    setIsMenuOpen(false);
  };

  useEffect(() => {
    if (!panes.find((pane) => pane.id === activeId) && panes.length > 0) {
      setActiveId(panes[0].id);
    }
  }, [panes, activeId]);

  useEffect(() => {
    if (!isProjectReady || !projectPath || panes.length === 0) return;
    saveSession({
      projectPath,
      workspaceName,
      panes: panes.map((pane) => ({ id: pane.id, name: pane.name })),
      activeId,
      lastSplit,
      gridLayoutId: fixedGridLayoutId ?? undefined,
      updatedAt: Date.now(),
    });
  }, [
    projectPath,
    workspaceName,
    fixedGridLayoutId,
    isProjectReady,
    panes,
    activeId,
    lastSplit,
  ]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    setDraftShortcuts(shortcuts);
    setDraftAppearanceSettings(appearanceSettings);
    setDraftWorkspacePreferences(workspacePreferences);
    setShortcutError(null);
  }, [
    isSettingsOpen,
    shortcuts,
    appearanceSettings,
    workspacePreferences,
  ]);

  const selectedWorkspaceGrid = useMemo(
    () => getGridLayout(workspaceSetupForm.gridLayoutId),
    [workspaceSetupForm.gridLayoutId],
  );

  const workspaceGridCapacity = getGridCapacity(selectedWorkspaceGrid);

  useEffect(() => {
    setWorkspaceSetupForm((current) => {
      const nextAllocations = { ...current.allocations };
      let changed = false;
      AGENT_OPTIONS.forEach((option) => {
        const allocation = nextAllocations[option.id] ?? {
          enabled: false,
          count: 0,
          command: option.defaultCommand,
        };
        const normalizedCommand =
          allocation.command.trim() || option.defaultCommand;
        const normalizedCount = allocation.enabled
          ? Math.max(1, Math.min(allocation.count || 1, workspaceGridCapacity))
          : 0;
        if (
          normalizedCount !== allocation.count ||
          normalizedCommand !== allocation.command
        ) {
          changed = true;
          nextAllocations[option.id] = {
            ...allocation,
            count: normalizedCount,
            command: normalizedCommand,
          };
        } else {
          nextAllocations[option.id] = allocation;
        }
      });
      if (!changed) return current;
      return { ...current, allocations: nextAllocations };
    });
  }, [workspaceGridCapacity]);

  const updateRecentProjects = (path: string) => {
    const next = [
      { path, lastOpened: Date.now() },
      ...recentProjects.filter((item) => item.path !== path),
    ].slice(0, MAX_RECENTS);
    setRecentProjects(next);
    saveRecentProjects(next);
  };

  const handleBrowseWorkspaceFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Project Folder",
    });
    if (typeof selected !== "string" || !selected.trim()) return;
    const path = selected.trim();
    const suggestedWorkspace = getFolderName(path);
    setWorkspaceSetupForm((current) => ({
      ...current,
      projectPath: path,
      workspaceName: current.workspaceName.trim()
        ? current.workspaceName
        : suggestedWorkspace || current.workspaceName,
    }));
  };

  const openWorkspaceSetup = (
    mode: WorkspaceSetupMode = "active-tab",
    seedName?: string,
  ) => {
    setWorkspaceSetupMode(mode);
    const currentPath =
      mode === "new-tab"
        ? loadLastProject()
        : projectPath || workspaceSetupForm.projectPath || loadLastProject();
    const fallbackWorkspace =
      seedName ||
      getFolderName(currentPath) ||
      workspaceName ||
      workspacePreferences.defaultWorkspaceName;
    setWorkspaceSetupForm((current) => ({
      ...current,
      projectPath: currentPath,
      workspaceName: current.workspaceName.trim()
        ? mode === "new-tab"
          ? fallbackWorkspace
          : current.workspaceName
        : fallbackWorkspace,
      gridLayoutId:
        mode === "new-tab"
          ? workspacePreferences.defaultGridLayoutId
          : fixedGridLayoutId ??
            current.gridLayoutId ??
            workspacePreferences.defaultGridLayoutId,
      allocations:
        mode === "new-tab" ? createDefaultAllocations() : current.allocations,
    }));
    setWorkspaceSetupError(null);
    setIsMenuOpen(false);
    setIsWorkspaceSetupOpen(true);
  };

  const updateAgentAllocation = (
    agentId: string,
    next: Partial<AgentAllocation>,
  ) => {
    setWorkspaceSetupError(null);
    setWorkspaceSetupForm((current) => {
      const agent = AGENT_OPTIONS.find((option) => option.id === agentId);
      if (!agent) return current;
      const existing = current.allocations[agentId] ?? {
        enabled: false,
        count: 0,
        command: agent.defaultCommand,
      };
      const merged = { ...existing, ...next };
      return {
        ...current,
        allocations: {
          ...current.allocations,
          [agentId]: merged,
        },
      };
    });
  };

  const totalAssignedPanels = useMemo(
    () =>
      AGENT_OPTIONS.reduce((sum, option) => {
        const allocation = workspaceSetupForm.allocations[option.id];
        if (!allocation?.enabled) return sum;
        return sum + Math.max(1, allocation.count || 1);
      }, 0),
    [workspaceSetupForm.allocations],
  );

  const handleWorkspaceLaunch = () => {
    const path = workspaceSetupForm.projectPath.trim();
    if (!path) {
      setWorkspaceSetupError("Choose a folder path before launching.");
      return;
    }

    const layout = getGridLayout(workspaceSetupForm.gridLayoutId);
    const capacity = getGridCapacity(layout);
    const enabledAgents = AGENT_OPTIONS.map((option) => {
      const allocation = workspaceSetupForm.allocations[option.id] ?? {
        enabled: false,
        count: 0,
        command: option.defaultCommand,
      };
      if (!allocation.enabled) return null;
      const count = Math.max(1, Math.min(allocation.count || 1, capacity));
      const command = (allocation.command || option.defaultCommand).trim();
      if (!command) {
        return {
          option,
          count,
          command,
          invalidCommand: true,
        };
      }
      return {
        option,
        count,
        command,
        invalidCommand: false,
      };
    }).filter((item): item is {
      option: AgentOption;
      count: number;
      command: string;
      invalidCommand: boolean;
    } => Boolean(item));

    const invalidAgent = enabledAgents.find((agent) => agent.invalidCommand);
    if (invalidAgent) {
      setWorkspaceSetupError(
        `Enter a valid CLI command for ${invalidAgent.option.label}.`,
      );
      return;
    }

    const assignedPanels = enabledAgents.reduce(
      (sum, agent) => sum + agent.count,
      0,
    );
    if (assignedPanels > capacity) {
      setWorkspaceSetupError(
        `Assigned panels (${assignedPanels}) exceed selected layout capacity (${capacity}).`,
      );
      return;
    }

    const resolvedWorkspaceName =
      workspaceSetupForm.workspaceName.trim() ||
      getFolderName(path) ||
      "Workspace";
    const nextPanes: Pane[] = Array.from({ length: capacity }, (_, index) => {
      const pane = createPane(index + 1);
      return {
        ...pane,
        name: `${resolvedWorkspaceName} - Terminal ${index + 1}`,
      };
    });

    const nextStartupCommands: Record<string, string> = {};
    let paneCursor = 0;
    enabledAgents.forEach((agent) => {
      for (let index = 0; index < agent.count; index += 1) {
        const pane = nextPanes[paneCursor];
        if (!pane) break;
        pane.name = `${resolvedWorkspaceName} - ${agent.option.label} ${index + 1}`;
        nextStartupCommands[pane.id] = agent.command;
        paneCursor += 1;
      }
    });

    const nextSplit = layout.rows >= layout.cols ? "horizontal" : "vertical";
    const nextSnapshot = buildSnapshot(
      path,
      resolvedWorkspaceName,
      nextPanes,
      nextPanes[0].id,
      nextSplit,
      layout.id,
    );
    if (workspaceSetupMode === "new-tab") {
      const nextTabId = createRuntimeId("tab");
      const currentSnapshot = isProjectReady
        ? buildSnapshot(
            projectPath,
            workspaceName,
            panes,
            activeId,
            lastSplit,
            fixedGridLayoutId,
          )
        : null;
      setTabs((current) => {
        const withCurrent = current.map((tab) =>
          tab.id === activeTabId
            ? {
                ...tab,
                title: workspaceName.trim() || tab.title,
                snapshot: currentSnapshot,
              }
            : tab,
        );
        return [
          ...withCurrent,
          {
            id: nextTabId,
            title: resolvedWorkspaceName,
            snapshot: nextSnapshot,
          },
        ];
      });
      setActiveTabId(nextTabId);
    } else {
      setTabs((current) =>
        current.map((tab) =>
          tab.id === activeTabId
            ? {
                ...tab,
                title: resolvedWorkspaceName,
                snapshot: nextSnapshot,
              }
            : tab,
        ),
      );
    }

    startupCommandExecuted.clear();
    setWorkspaceName(resolvedWorkspaceName);
    setProjectPath(path);
    setPanes(nextPanes);
    setActiveId(nextPanes[0].id);
    setLayoutTick((tick) => tick + 1);
    setFixedGridLayoutId(layout.id);
    setLastSplit(nextSplit);
    setStartupCommands(nextStartupCommands);
    saveLastProject(path);
    setIsProjectReady(true);
    setIsWorkspaceSetupOpen(false);
    setWorkspaceSetupMode("active-tab");
    setIsMenuOpen(false);
    setWorkspaceSetupError(null);
    updateRecentProjects(path);
  };

  const openExistingProject = (path: string) => {
    const pane = createPane(1);
    startupCommandExecuted.clear();
    setProjectPath(path);
    setWorkspaceName(getFolderName(path) || "Workspace");
    setIsProjectReady(true);
    setFixedGridLayoutId(null);
    setStartupCommands({});
    setPanes([pane]);
    setActiveId(pane.id);
    setLayoutTick((tick) => tick + 1);
    saveLastProject(path);
    setIsMenuOpen(false);
    updateRecentProjects(path);
  };

  const getGrid = (count: number, preferred: "horizontal" | "vertical") => {
    const safeCount = Math.max(1, count);
    let bestRows = 1;
    let bestCols = safeCount;
    let bestDiff = Number.MAX_SAFE_INTEGER;

    for (let i = 1; i <= Math.sqrt(safeCount); i += 1) {
      if (safeCount % i === 0) {
        const rows = i;
        const cols = safeCount / i;
        const diff = Math.abs(rows - cols);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestRows = rows;
          bestCols = cols;
        }
      }
    }

    if (safeCount > MAX_SPLITS * MAX_SPLITS) {
      bestRows = MAX_SPLITS;
      bestCols = MAX_SPLITS;
    }

    if (safeCount % bestRows !== 0) {
      // Prime count, choose orientation based on preferred split.
      if (preferred === "horizontal") {
        bestRows = safeCount;
        bestCols = 1;
      } else {
        bestRows = 1;
        bestCols = safeCount;
      }
    } else if (preferred === "horizontal" && bestRows < bestCols) {
      [bestRows, bestCols] = [bestCols, bestRows];
    } else if (preferred === "vertical" && bestCols < bestRows) {
      [bestRows, bestCols] = [bestCols, bestRows];
    }

    return { rows: bestRows, cols: bestCols };
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        setIsPaletteOpen(true);
        setPaletteQuery("");
        return;
      }

      if (event.key === "F11") {
        event.preventDefault();
        event.stopPropagation();
        setIsFullscreen((current) => {
          const next = !current;
          void appWindow.setFullscreen(next);
          return next;
        });
        return;
      }

      if (!event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "v") {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            const text = await readClipboardText();
            if (text) {
              await invoke("pty_write", { id: activeId, data: text });
              return;
            }
          } catch {
            // Ignore clipboard errors; fallback to default behavior.
          }
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              await invoke("pty_write", { id: activeId, data: text });
            }
          } catch {
            // Ignore clipboard errors.
          }
        })();
        return;
      }
      const splitHorizontalKey = shortcuts.splitHorizontalKey;
      const splitVerticalKey = shortcuts.splitVerticalKey;
      if (key !== splitHorizontalKey && key !== splitVerticalKey && key !== "w")
        return;

      event.preventDefault();
      event.stopPropagation();

      if (!isProjectReady) return;

      if (panes.length >= MAX_SPLITS * MAX_SPLITS) {
        return;
      }

      if (key === "w") {
        handleClose(activeId);
        return;
      }

      setPanes((current) => {
        const activeIndex = current.findIndex((pane) => pane.id === activeId);
        const next = [...current];
        const insertIndex = activeIndex === -1 ? next.length : activeIndex + 1;
        next.splice(insertIndex, 0, createPane(next.length + 1));
        setLastSplit(key === splitHorizontalKey ? "horizontal" : "vertical");
        return next;
      });
      setLayoutTick((tick) => tick + 1);
    };

    window.addEventListener("keydown", handleKey, true);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [appWindow, activeId, isProjectReady, panes.length]);

  useEffect(() => {
    setLayoutTick((tick) => tick + 1);
  }, [panes.length]);

  const handleClose = (id: string) => {
    startupCommandExecuted.delete(id);
    setPanes((current) => {
      if (current.length <= 1) return current;
      const next = current.filter((pane) => pane.id !== id);
      return next;
    });
    setStartupCommands((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setLayoutTick((tick) => tick + 1);
  };

  const handleStartupCommandConsumed = (id: string) => {
    setStartupCommands((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const handleRunCommand = async (command: string) => {
    if (!isProjectReady || !activeId) return;
    await invoke("pty_write", { id: activeId, data: `${command}\r` });
  };

  const buildWhisperOptions = useCallback(() => {
    const options: {
      modelPath?: string;
      whisperBinary?: string;
    } = {};
    const modelPath = whisperModelPathRef.current.trim();
    const whisperBinary = whisperBinaryPathRef.current.trim();
    if (modelPath) options.modelPath = modelPath;
    if (whisperBinary) options.whisperBinary = whisperBinary;
    return options;
  }, []);

  const tryResolveWhisperRequirements = useCallback(async (errorMessage: string) => {
    let updated = false;
    const missingModel =
      errorMessage.includes("Whisper model path is missing") ||
      errorMessage.includes("Tiny Whisper models are disabled");
    const missingBinary =
      errorMessage.includes("Failed to launch whisper binary") ||
      errorMessage.includes("STATUS_DLL_NOT_FOUND") ||
      errorMessage.includes("STATUS_INVALID_IMAGE_FORMAT") ||
      errorMessage.includes("No process output captured.");

    if (missingModel) {
      const selectedModel = await open({
        directory: false,
        multiple: false,
        title: "Select Whisper Model (.bin)",
        filters: [{ name: "Whisper Model", extensions: ["bin"] }],
      });
      const selectedModelPath =
        typeof selectedModel === "string" ? selectedModel.trim() : "";
      if (selectedModelPath) {
        whisperModelPathRef.current = selectedModelPath;
        saveStoredWhisperPath(WHISPER_MODEL_PATH_KEY, selectedModelPath);
        updated = true;
      }
    }

    if (missingBinary) {
      const selectedBinary = await open({
        directory: false,
        multiple: false,
        title: "Select Whisper CLI binary",
      });
      const selectedBinaryPath =
        typeof selectedBinary === "string" ? selectedBinary.trim() : "";
      if (selectedBinaryPath) {
        whisperBinaryPathRef.current = selectedBinaryPath;
        saveStoredWhisperPath(WHISPER_BINARY_PATH_KEY, selectedBinaryPath);
        updated = true;
      }
    }

    return updated;
  }, []);

  const transcribeWithRecovery = useCallback(
    async (runTranscription: () => Promise<string>) => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await runTranscription();
        } catch (error) {
          lastError = error;
          const resolved = await tryResolveWhisperRequirements(formatErrorMessage(error));
          if (!resolved) break;
        }
      }
      throw lastError ?? new Error("Whisper transcription failed.");
    },
    [tryResolveWhisperRequirements],
  );

  const handleTranscribeAudioFile = async () => {
    if (SPEECH_TO_TEXT_DISABLED) {
      await message("Speech-to-text is currently disabled in this build.", {
        title: "Speech-to-Text Disabled",
        kind: "info",
      });
      return;
    }
    if (!isProjectReady || !activeId) {
      await message("Open a workspace first to insert transcript output.", {
        title: "No Active Workspace",
        kind: "info",
      });
      return;
    }

    const selected = await open({
      directory: false,
      multiple: false,
      title: "Select Audio File",
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"],
        },
      ],
    });
    const selectedPath = typeof selected === "string" ? selected.trim() : "";
    if (!selectedPath) return;

    try {
      const transcript = await transcribeWithRecovery(() =>
        invoke<string>("whisper_transcribe_local_file", {
          audioPath: selectedPath,
          ...buildWhisperOptions(),
        }),
      );
      const cleanedTranscript = transcript.trim();
      if (!cleanedTranscript) {
        await message("No speech text was detected in the selected file.", {
          title: "No Transcript",
          kind: "info",
        });
        return;
      }
      await invoke("pty_write", { id: activeId, data: cleanedTranscript });
    } catch (error) {
      await message(`Unable to transcribe the selected audio file.\n\n${formatErrorMessage(error)}`, {
        title: "Transcription Error",
        kind: "error",
      });
    }
  };

  const cleanupSpeechCaptureResources = useCallback(async () => {
    speechRecordingRef.current = false;
    if (speechProcessorRef.current) {
      speechProcessorRef.current.onaudioprocess = null;
      speechProcessorRef.current.disconnect();
      speechProcessorRef.current = null;
    }
    if (speechSourceRef.current) {
      speechSourceRef.current.disconnect();
      speechSourceRef.current = null;
    }
    if (speechSilenceRef.current) {
      speechSilenceRef.current.disconnect();
      speechSilenceRef.current = null;
    }
    if (speechStreamRef.current) {
      speechStreamRef.current.getTracks().forEach((track) => track.stop());
      speechStreamRef.current = null;
    }
    if (speechAudioContextRef.current) {
      try {
        await speechAudioContextRef.current.close();
      } catch {
        // Ignore audio context close errors.
      }
      speechAudioContextRef.current = null;
    }
  }, []);

  const resetSpeechOverlay = useCallback(() => {
    speechChunksRef.current = [];
    speechStopRequestedRef.current = false;
    setSpeechWaveLevels(createSpeechWaveLevels());
    setSpeechCaptureState("idle");
  }, []);

  const handleCancelSpeechCapture = useCallback(async () => {
    speechStopRequestedRef.current = false;
    speechStartTokenRef.current += 1;
    speechStartInFlightRef.current = false;
    await cleanupSpeechCaptureResources();
    resetSpeechOverlay();
  }, [cleanupSpeechCaptureResources, resetSpeechOverlay]);

  const handleStartSpeechCapture = useCallback(async () => {
    if (SPEECH_MIC_CAPTURE_DISABLED) {
      setSpeechCaptureState("idle");
      return;
    }
    if (speechCaptureState === "recording" || speechCaptureState === "transcribing") {
      return;
    }
    if (speechStartInFlightRef.current || speechRecordingRef.current) return;
    if (!isProjectReady || !activeId) return;

    speechStopRequestedRef.current = false;
    speechStartInFlightRef.current = true;
    const startToken = speechStartTokenRef.current + 1;
    speechStartTokenRef.current = startToken;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audioContext = new AudioContext();
      await audioContext.resume();
      if (speechStartTokenRef.current !== startToken) {
        return;
      }

      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      const silenceNode = audioContext.createGain();
      silenceNode.gain.value = 0;

      speechChunksRef.current = [];
      speechSampleRateRef.current = audioContext.sampleRate;
      speechRecordingRef.current = true;
      processorNode.onaudioprocess = (event) => {
        if (!speechRecordingRef.current) return;
        const channelData = event.inputBuffer.getChannelData(0);
        speechChunksRef.current.push(new Float32Array(channelData));
        const nextLevels = computeSpeechWaveLevels(channelData);
        setSpeechWaveLevels((current) =>
          current.map((value, index) => {
            const nextValue = nextLevels[index] ?? SPEECH_WAVE_IDLE_LEVEL;
            const decayed = Math.max(SPEECH_WAVE_IDLE_LEVEL, value * 0.74);
            return Math.max(nextValue, decayed);
          }),
        );
      };

      sourceNode.connect(processorNode);
      processorNode.connect(silenceNode);
      silenceNode.connect(audioContext.destination);

      speechStreamRef.current = stream;
      stream = null;
      speechAudioContextRef.current = audioContext;
      audioContext = null;
      speechSourceRef.current = sourceNode;
      speechProcessorRef.current = processorNode;
      speechSilenceRef.current = silenceNode;
      setSpeechCaptureState("recording");
      if (!speechCtrlPressedRef.current) {
        speechStopRequestedRef.current = true;
      }
    } catch {
      await cleanupSpeechCaptureResources();
      setSpeechWaveLevels(createSpeechWaveLevels());
      setSpeechCaptureState("idle");
    } finally {
      speechStartInFlightRef.current = false;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (audioContext) {
        try {
          await audioContext.close();
        } catch {
          // Ignore audio context close errors.
        }
      }
    }
  }, [
    activeId,
    cleanupSpeechCaptureResources,
    isProjectReady,
    speechCaptureState,
  ]);

  const handleStopSpeechCapture = useCallback(async () => {
    if (!speechRecordingRef.current && speechCaptureState !== "recording") return;
    speechStopRequestedRef.current = false;
    setSpeechCaptureState("transcribing");
    speechRecordingRef.current = false;
    speechStartTokenRef.current += 1;
    speechStartInFlightRef.current = false;

    await cleanupSpeechCaptureResources();

    const mergedAudio = mergeAudioChunks(speechChunksRef.current);
    speechChunksRef.current = [];
    if (mergedAudio.length === 0) {
      setSpeechWaveLevels(createSpeechWaveLevels());
      setSpeechCaptureState("idle");
      return;
    }

    const downsampledAudio = downsampleAudio(
      mergedAudio,
      speechSampleRateRef.current,
      SPEECH_SAMPLE_RATE,
    );
    const waveBytes = encodeWave16BitPcm(downsampledAudio, SPEECH_SAMPLE_RATE);

    try {
      const transcript = await transcribeWithRecovery(() =>
        invoke<string>("whisper_transcribe_local", {
          audioBytes: Array.from(waveBytes),
          ...buildWhisperOptions(),
        }),
      );
      const cleanedTranscript = transcript.trim();
      if (!cleanedTranscript) {
        throw new Error("No speech text detected.");
      }

      await invoke("pty_write", { id: activeId, data: cleanedTranscript });
    } catch (error) {
      await message(`Unable to transcribe microphone audio.\n\n${formatErrorMessage(error)}`, {
        title: "Transcription Error",
        kind: "error",
      });
    }
    setSpeechWaveLevels(createSpeechWaveLevels());
    setSpeechCaptureState("idle");
  }, [
    activeId,
    buildWhisperOptions,
    cleanupSpeechCaptureResources,
    speechCaptureState,
    transcribeWithRecovery,
  ]);

  useEffect(() => {
    if (SPEECH_MIC_CAPTURE_DISABLED) return;

    const handleSpeechKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Control") {
        if (speechCtrlPressedRef.current) {
          speechCtrlChordRef.current = true;
          setIsSpeechCtrlHeld(false);
          void handleCancelSpeechCapture();
        }
        return;
      }
      if (event.repeat || event.metaKey || event.altKey) return;
      const targetElement = event.target as HTMLElement | null;
      const isXtermHelperTextarea =
        targetElement?.classList?.contains("xterm-helper-textarea") ?? false;
      const isBlockedEditableTarget =
        isEditableTarget(event.target) && !isXtermHelperTextarea;
      if (isBlockedEditableTarget) return;
      speechCtrlPressedRef.current = true;
      speechCtrlChordRef.current = false;
      setIsSpeechCtrlHeld(true);
      if (speechCaptureState !== "recording" && speechCaptureState !== "transcribing") {
        void handleStartSpeechCapture();
      }
    };

    const handleSpeechKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control") return;
      if (!speechCtrlPressedRef.current) return;

      speechCtrlPressedRef.current = false;
      setIsSpeechCtrlHeld(false);
      const targetElement = event.target as HTMLElement | null;
      const isXtermHelperTextarea =
        targetElement?.classList?.contains("xterm-helper-textarea") ?? false;
      const isBlockedEditableTarget =
        isEditableTarget(event.target) && !isXtermHelperTextarea;
      if (isBlockedEditableTarget || speechCtrlChordRef.current) {
        speechCtrlChordRef.current = false;
        void handleCancelSpeechCapture();
        return;
      }
      speechCtrlChordRef.current = false;

      event.preventDefault();
      event.stopPropagation();

      if (speechRecordingRef.current || speechCaptureState === "recording") {
        void handleStopSpeechCapture();
        return;
      }
      if (speechStartInFlightRef.current) {
        speechStopRequestedRef.current = true;
        return;
      }
      void handleCancelSpeechCapture();
    };

    const resetSpeechCtrlState = () => {
      speechCtrlPressedRef.current = false;
      speechCtrlChordRef.current = false;
      speechStopRequestedRef.current = false;
      setIsSpeechCtrlHeld(false);
      void handleCancelSpeechCapture();
    };

    window.addEventListener("keydown", handleSpeechKeyDown, true);
    window.addEventListener("keyup", handleSpeechKeyUp, true);
    window.addEventListener("blur", resetSpeechCtrlState);
    return () => {
      window.removeEventListener("keydown", handleSpeechKeyDown, true);
      window.removeEventListener("keyup", handleSpeechKeyUp, true);
      window.removeEventListener("blur", resetSpeechCtrlState);
    };
  }, [
    speechCaptureState,
    handleCancelSpeechCapture,
    handleStartSpeechCapture,
    handleStopSpeechCapture,
  ]);

  useEffect(() => {
    if (speechCaptureState !== "recording") return;
    if (!speechStopRequestedRef.current) return;
    speechStopRequestedRef.current = false;
    void handleStopSpeechCapture();
  }, [speechCaptureState, handleStopSpeechCapture]);

  useEffect(
    () => () => {
      void cleanupSpeechCaptureResources();
    },
    [],
  );

  const openSettings = (section: SettingsSection = "controls") => {
    setActiveSettingsSection(section);
    setIsSettingsOpen(true);
  };

  const closeSettings = () => {
    setIsSettingsOpen(false);
    setShortcutError(null);
  };

  const handleShortcutChange = (
    field: "splitHorizontalKey" | "splitVerticalKey",
    value: string,
  ) => {
    const next = { ...draftShortcuts, [field]: normalizeShortcutKey(value) };
    setDraftShortcuts(next);
    setShortcutError(null);
  };

  const handleImageDropFormatChange = (
    value: ShortcutSettings["imageDropFormat"],
  ) => {
    setDraftShortcuts((current) => ({ ...current, imageDropFormat: value }));
    setShortcutError(null);
  };

  const handleSelectUiPreset = (presetId: UiPreset) => {
    const preset = UI_PRESET_OPTIONS.find((option) => option.id === presetId);
    if (!preset) return;
    setDraftAppearanceSettings({
      appTheme: preset.theme,
      appLayout: preset.layout,
      activityMotion: preset.activityMotion,
      closeButtonMode: preset.closeButtonMode,
      uiPreset: preset.id,
    });
  };

  const handleSaveShortcuts = () => {
    const splitHorizontalKey = normalizeShortcutKey(
      draftShortcuts.splitHorizontalKey,
    );
    const splitVerticalKey = normalizeShortcutKey(
      draftShortcuts.splitVerticalKey,
    );

    if (!splitHorizontalKey || !splitVerticalKey) {
      setShortcutError("Both shortcuts must be a single letter.");
      return;
    }
    if (splitHorizontalKey === splitVerticalKey) {
      setShortcutError("Shortcuts must be different.");
      return;
    }
    if (splitHorizontalKey === "w" || splitVerticalKey === "w") {
      setShortcutError("Ctrl+W is reserved for closing a pane.");
      return;
    }

    const imageDropFormat: ShortcutSettings["imageDropFormat"] =
      draftShortcuts.imageDropFormat === "separate-lines"
        ? "separate-lines"
        : "single-line";
    const next = { splitHorizontalKey, splitVerticalKey, imageDropFormat };
    setShortcuts(next);
    saveShortcuts(next);
    closeSettings();
  };

  const handleSaveAppearance = () => {
    setAppearanceSettings(draftAppearanceSettings);
    saveAppearanceSettings(draftAppearanceSettings);
    closeSettings();
  };

  const handleSaveWorkspacePreferences = () => {
    const next: WorkspacePreferences = {
      defaultWorkspaceName:
        draftWorkspacePreferences.defaultWorkspaceName.trim() ||
        DEFAULT_WORKSPACE_PREFERENCES.defaultWorkspaceName,
      defaultGridLayoutId: GRID_LAYOUT_OPTIONS.some(
        (option) => option.id === draftWorkspacePreferences.defaultGridLayoutId,
      )
        ? draftWorkspacePreferences.defaultGridLayoutId
        : DEFAULT_WORKSPACE_PREFERENCES.defaultGridLayoutId,
    };
    setWorkspacePreferences(next);
    saveWorkspacePreferences(next);
    closeSettings();
  };

  const handleOpenServersWindow = async () => {
    setIsServersInline(true);
    const existing = await WebviewWindow.getByLabel("servers");
    if (existing) {
      if (typeof (existing as WebviewWindow).show === "function") {
        (existing as WebviewWindow).show();
      }
      if (typeof (existing as WebviewWindow).setFocus === "function") {
        void (existing as WebviewWindow).setFocus();
      }
      return;
    }
    try {
      const serverWindow = new WebviewWindow("servers", {
        title: "Servers",
        width: 1000,
        height: 720,
        resizable: true,
        url:
          typeof window !== "undefined"
            ? `${window.location.origin}/?view=servers`
            : "/?view=servers",
      });
      serverWindow.once("tauri://created", () => {
        const maybeFocus = (serverWindow as { setFocus?: () => void }).setFocus;
        if (typeof maybeFocus === "function") {
          void maybeFocus.call(serverWindow);
        }
        setIsServersInline(false);
      });
      serverWindow.once("tauri://error", () => {
        setIsServersInline(true);
      });
    } catch {
      setIsServersInline(true);
    }
  };

  const handleCheckForUpdates = async (silent = false) => {
    if (isCheckingForUpdates) return;
    setIsCheckingForUpdates(true);
    let update: Awaited<ReturnType<typeof check>> = null;
    try {
      const githubToken = updaterSettings.githubToken.trim();
      const checkOptions = githubToken
        ? {
            headers: {
              Authorization: `Bearer ${githubToken}`,
              Accept: "application/octet-stream",
            },
          }
        : undefined;
      update = await check(checkOptions);
      if (!update) {
        setAvailableUpdateVersion(null);
        if (!silent) {
          await message("You are already on the latest version.", {
            title: "No Updates Available",
            kind: "info",
          });
        }
        return;
      }

      setAvailableUpdateVersion(update.version);
      if (silent) return;

      const shouldInstall = await confirm(
        `Version ${update.version} is available. Download and install now?`,
        {
          title: "Update Available",
          kind: "info",
          okLabel: "Install",
          cancelLabel: "Later",
        },
      );
      if (!shouldInstall) return;

      await update.downloadAndInstall();
      setAvailableUpdateVersion(null);

      const shouldRestart = await confirm(
        "Update installed successfully. Restart now to finish applying it?",
        {
          title: "Restart Required",
          kind: "info",
          okLabel: "Restart",
          cancelLabel: "Later",
        },
      );
      if (shouldRestart) {
        await relaunch();
      }
    } catch (error) {
      const rawMessage = formatErrorMessage(error);
      const normalizedError = rawMessage.toLowerCase();
      const privateRepoHint =
        normalizedError.includes("valid release json") ||
        normalizedError.includes("not found")
          ? "\n\nUpdater endpoint returned 404/invalid JSON. If the GitHub repo is private, add a read-only GitHub token in Settings > Updates, or make releases public."
          : "";
      if (!silent) {
        await message(`Unable to check for updates.\n\n${rawMessage}${privateRepoHint}`, {
          title: "Update Error",
          kind: "error",
        });
      }
    } finally {
      if (update) {
        try {
          await update.close();
        } catch {
          // Ignore cleanup errors after updater calls.
        }
      }
      setIsCheckingForUpdates(false);
    }
  };

  useEffect(() => {
    void handleCheckForUpdates(true);
    // Run once on app launch to surface pending updates in the menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paletteActions = useMemo(() => {
    const actions: Array<{
      id: string;
      label: string;
      hint?: string;
      run: () => void;
    }> = [
      {
        id: "open-project",
        label: "Open workspace setup",
        run: () => {
          openWorkspaceSetup();
          setIsPaletteOpen(false);
        },
      },
    ];

    if (isProjectReady) {
      actions.push(
        {
          id: "split-horizontal",
          label: "Split horizontal",
          hint: `Ctrl+${shortcuts.splitHorizontalKey.toUpperCase()}`,
          run: () => {
            setPanes((current) => {
              const activeIndex = current.findIndex(
                (pane) => pane.id === activeId,
              );
              const next = [...current];
              const insertIndex =
                activeIndex === -1 ? next.length : activeIndex + 1;
              next.splice(insertIndex, 0, createPane(next.length + 1));
              setLastSplit("horizontal");
              return next;
            });
            setLayoutTick((tick) => tick + 1);
            setIsPaletteOpen(false);
          },
        },
        {
          id: "split-vertical",
          label: "Split vertical",
          hint: `Ctrl+${shortcuts.splitVerticalKey.toUpperCase()}`,
          run: () => {
            setPanes((current) => {
              const activeIndex = current.findIndex(
                (pane) => pane.id === activeId,
              );
              const next = [...current];
              const insertIndex =
                activeIndex === -1 ? next.length : activeIndex + 1;
              next.splice(insertIndex, 0, createPane(next.length + 1));
              setLastSplit("vertical");
              return next;
            });
            setLayoutTick((tick) => tick + 1);
            setIsPaletteOpen(false);
          },
        },
        {
          id: "close-pane",
          label: "Close active pane",
          hint: "Ctrl+W",
          run: () => {
            handleClose(activeId);
            setIsPaletteOpen(false);
          },
        },
        {
          id: "open-settings",
          label: "Open settings",
          run: () => {
            openSettings("controls");
            setIsPaletteOpen(false);
          },
        },
        {
          id: "transcribe-audio-file",
          label: "Transcribe audio file",
          hint: "Local Whisper",
          run: () => {
            void handleTranscribeAudioFile();
            setIsPaletteOpen(false);
          },
        },
      );
    }

    return actions;
  }, [
    activeId,
    isProjectReady,
    openWorkspaceSetup,
    shortcuts.splitHorizontalKey,
    shortcuts.splitVerticalKey,
  ]);

  const filteredPaletteActions = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    if (!query) return paletteActions;
    const matches = paletteActions.filter((action) =>
      `${action.label} ${action.hint ?? ""}`.toLowerCase().includes(query),
    );
    if (query.startsWith(">") && isProjectReady) {
      const command = query.slice(1).trim();
      if (command.length > 0) {
        matches.unshift({
          id: "run-ad-hoc",
          label: `Run: ${command}`,
          hint: "Send to active terminal",
          run: () => {
            void handleRunCommand(command);
            setIsPaletteOpen(false);
          },
        });
      }
    }
    return matches;
  }, [paletteActions, paletteQuery, isProjectReady]);

  const workspaceSetupModal = isWorkspaceSetupOpen ? (
    <div className="modal-backdrop" onClick={() => setIsWorkspaceSetupOpen(false)}>
      <div
        className="modal workspace-setup-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">Open Workspace</div>
            <div className="modal-subtitle">
              Pick folder, layout, and coding agent instances in one action.
            </div>
          </div>
          <button
            className="btn"
            onClick={() => setIsWorkspaceSetupOpen(false)}
            aria-label="Close workspace setup"
          >
            ×
          </button>
        </div>
        <form
          className="modal-body workspace-setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            handleWorkspaceLaunch();
          }}
        >
          <label className="workspace-field">
            <span>Workspace Name</span>
            <input
              value={workspaceSetupForm.workspaceName}
              onChange={(event) =>
                setWorkspaceSetupForm((current) => ({
                  ...current,
                  workspaceName: event.target.value,
                }))
              }
              placeholder="My Workspace"
            />
          </label>

          <label className="workspace-field">
            <span>Folder Path</span>
            <div className="workspace-path-row">
              <input
                value={workspaceSetupForm.projectPath}
                onChange={(event) =>
                  setWorkspaceSetupForm((current) => ({
                    ...current,
                    projectPath: event.target.value,
                  }))
                }
                placeholder="C:\\path\\to\\project"
              />
              <button
                type="button"
                className="btn secondary"
                onClick={() => void handleBrowseWorkspaceFolder()}
              >
                Browse
              </button>
            </div>
          </label>

          <div className="workspace-grid-row">
            <label className="workspace-field">
              <span>Grid Layout</span>
              <select
                value={workspaceSetupForm.gridLayoutId}
                onChange={(event) =>
                  setWorkspaceSetupForm((current) => ({
                    ...current,
                    gridLayoutId: event.target.value,
                  }))
                }
              >
                {GRID_LAYOUT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} ({getGridCapacity(option)} panes max)
                  </option>
                ))}
              </select>
            </label>
            <div className="workspace-field">
              <span>Panel Capacity</span>
              <div className="workspace-capacity-value">
                {workspaceGridCapacity} panels
              </div>
            </div>
          </div>

          <div className="workspace-field">
            <span>CLI Agent Allocation</span>
            <div className="agent-allocation-list">
              {AGENT_OPTIONS.map((option) => {
                const allocation = workspaceSetupForm.allocations[option.id] ?? {
                  enabled: false,
                  count: 0,
                  command: option.defaultCommand,
                };
                const ownCount = allocation.enabled
                  ? Math.max(1, allocation.count || 1)
                  : 0;
                const assignedToOthers = totalAssignedPanels - ownCount;
                const maxForThisAgent = Math.max(
                  1,
                  workspaceGridCapacity - assignedToOthers,
                );
                return (
                  <div className="agent-allocation-row" key={option.id}>
                    <label className="agent-allocation-toggle">
                      <input
                        type="checkbox"
                        checked={allocation.enabled}
                        onChange={(event) =>
                          updateAgentAllocation(option.id, {
                            enabled: event.target.checked,
                            count: event.target.checked
                              ? Math.max(
                                  1,
                                  Math.min(allocation.count || 1, maxForThisAgent),
                                )
                              : 0,
                          })
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                    <div className="agent-allocation-count">
                      <input
                        type="number"
                        min={1}
                        max={maxForThisAgent}
                        value={allocation.enabled ? ownCount : 0}
                        disabled={!allocation.enabled}
                        onChange={(event) => {
                          const parsed = Number.parseInt(event.target.value, 10);
                          const normalized = Number.isNaN(parsed)
                            ? 1
                            : Math.max(1, Math.min(parsed, maxForThisAgent));
                          updateAgentAllocation(option.id, {
                            enabled: true,
                            count: normalized,
                          });
                        }}
                      />
                      <span className="workspace-helper">panels</span>
                    </div>
                    <input
                      className="agent-command-input"
                      value={allocation.command}
                      onChange={(event) =>
                        updateAgentAllocation(option.id, {
                          command: event.target.value,
                        })
                      }
                      placeholder={
                        option.defaultCommand || "custom-agent --project ."
                      }
                    />
                  </div>
                );
              })}
            </div>
            <div
              className={
                totalAssignedPanels > workspaceGridCapacity
                  ? "field-error"
                  : "workspace-helper"
              }
            >
              Assigned agent panels: {totalAssignedPanels} / {workspaceGridCapacity}
            </div>
            <div className="workspace-helper">
              Unassigned panels open as normal terminals.
            </div>
          </div>

          {workspaceSetupError && <div className="field-error">{workspaceSetupError}</div>}

          <div className="modal-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() => setIsWorkspaceSetupOpen(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Enter
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  const appThemeClass = `theme-${appearanceSettings.appTheme}`;
  const appLayoutClass = `layout-${appearanceSettings.appLayout}`;
  const uiPresetClass = `ui-${appearanceSettings.uiPreset}`;
  const activityMotionClass =
    appearanceSettings.activityMotion === "slow"
      ? "activity-slow"
      : appearanceSettings.activityMotion === "balanced"
        ? "activity-balanced"
        : "activity-fast";
  const closeModeClass =
    appearanceSettings.closeButtonMode === "always" ? "close-dot-always" : "";
  const isSpeechOverlayVisible = !SPEECH_MIC_CAPTURE_DISABLED && isSpeechCtrlHeld;

  const handleWindowClose = () => {
    void appWindow.close();
  };

  const handleWindowMinimize = () => {
    void appWindow.minimize();
  };

  const handleWindowZoom = () => {
    void (async () => {
      const maximized = await appWindow.isMaximized();
      if (maximized) {
        await appWindow.unmaximize();
        return;
      }
      await appWindow.maximize();
    })();
  };

  const windowControls = (
    <div className="topbar-window-controls" aria-label="Window controls">
      <button
        className="window-control-btn close"
        onClick={handleWindowClose}
        aria-label="Close window"
        title="Close"
      >
        <span className="window-control-glyph">×</span>
      </button>
      <button
        className="window-control-btn minimize"
        onClick={handleWindowMinimize}
        aria-label="Minimize window"
        title="Minimize"
      >
        <span className="window-control-glyph">−</span>
      </button>
      <button
        className="window-control-btn zoom"
        onClick={handleWindowZoom}
        aria-label="Maximize window"
        title="Zoom"
      >
        <span className="window-control-glyph">+</span>
      </button>
    </div>
  );

  if (!isProjectReady) {
    return (
      <div
        className={`app ${isFullscreen ? "fullscreen" : ""} ${appThemeClass} ${appLayoutClass} ${uiPresetClass} ${activityMotionClass} ${closeModeClass}`}
      >
        <header className="topbar startup-topbar">
          {windowControls}
          <div className="topbar-drag-zone startup" data-tauri-drag-region />
        </header>
        <div className="project-screen">
          <div className="project-shell">
            <div className="project-header">
              <div className="brand-title">Workspace</div>
              <div className="brand-subtitle">
                Modular workspace. Start with a project, then add tools.
              </div>
            </div>
            <div className="project-actions">
              <button className="btn primary" onClick={() => openWorkspaceSetup()}>
                Open Folder
              </button>
              {projectPath && <div className="project-path">{projectPath}</div>}
            </div>
            {availableUpdateVersion && (
              <div className="startup-update-card">
                <div className="startup-update-copy">
                  <div className="startup-update-label">Update Available</div>
                  <div className="startup-update-title">
                    Version v{availableUpdateVersion} is ready to install.
                  </div>
                  <div className="startup-update-meta">
                    Includes latest fixes and features from your newest release.
                  </div>
                </div>
                <button
                  className="btn primary startup-update-action"
                  onClick={() => void handleCheckForUpdates()}
                  disabled={isCheckingForUpdates}
                >
                  {isCheckingForUpdates ? "Checking..." : "Install Update"}
                </button>
              </div>
            )}
            {recentProjects.length > 0 && (
              <div className="recent-section">
                <div className="recent-title">Recent Projects</div>
                <div className="recent-list">
                  {recentProjects.map((project) => (
                    <button
                      key={project.path}
                      className="recent-item"
                      onClick={() => openExistingProject(project.path)}
                      title={project.path}
                    >
                      <span className="recent-name">{project.path}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="module-grid">
              <div className="module-card active">
                <div className="module-title">Terminal Grid</div>
                <div className="module-meta">
                  Multi-pane CMD terminals with split shortcuts.
                </div>
                <div className="module-tag">Enabled</div>
              </div>
              <div className="module-card">
                <div className="module-title">Agent Console</div>
                <div className="module-meta">
                  Route CLI agents into dedicated panes.
                </div>
                <div className="module-tag">Planned</div>
              </div>
              <div className="module-card">
                <div className="module-title">Context Vault</div>
                <div className="module-meta">
                  Project memory, notes, and snippets.
                </div>
                <div className="module-tag">Planned</div>
              </div>
            </div>
          </div>
        </div>
        {workspaceSetupModal}
      </div>
    );
  }

  const handleMenuAction = (run: () => void) => {
    run();
    setIsMenuOpen(false);
  };

  const activeSettingsMeta =
    SETTINGS_SECTIONS.find((section) => section.id === activeSettingsSection) ??
    SETTINGS_SECTIONS[0];

  let activityVariantCursor = 0;
  const getNextActivityVariant = () => {
    const next = (activityVariantCursor % ACTIVITY_VARIANT_COUNT) + 1;
    activityVariantCursor += 1;
    return next;
  };

  return (
    <div
      className={`app ${isFullscreen ? "fullscreen" : ""} ${appThemeClass} ${appLayoutClass} ${uiPresetClass} ${activityMotionClass} ${closeModeClass}`}
    >
      <header className="topbar">
        {windowControls}
        <div className="topbar-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`topbar-tab ${tab.id === activeTabId ? "active" : ""}`}
              title={tab.snapshot?.projectPath || tab.title}
            >
              <button
                className="topbar-tab-main"
                onClick={() => handleSelectTab(tab.id)}
                onDoubleClick={() => handleRenameTab(tab.id)}
              >
                {tab.title}
              </button>
              {tabs.length > 1 && (
                <button
                  className="topbar-tab-close"
                  onClick={() => handleDeleteTab(tab.id)}
                  title="Delete tab"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            className="topbar-tab add"
            onClick={() =>
              openWorkspaceSetup("new-tab", `Tab ${tabs.length + 1}`)
            }
            title="New tab"
          >
            +
          </button>
        </div>
        <div className="topbar-drag-zone" data-tauri-drag-region />
        <div className="topbar-menu" ref={menuRef}>
          <button
            className="btn secondary"
            onClick={() => setIsMenuOpen((current) => !current)}
          >
            Menu
          </button>
          {isMenuOpen && (
            <div className="topbar-dropdown">
              <button
                className="topbar-dropdown-item"
                onClick={() => handleMenuAction(openWorkspaceSetup)}
              >
                Open Folder
              </button>
              <button
                className="topbar-dropdown-item"
                onClick={() => handleMenuAction(() => handleRenameTab(activeTabId))}
              >
                Rename Tab
              </button>
              <button
                className="topbar-dropdown-item"
                onClick={() => handleMenuAction(() => handleDeleteTab(activeTabId))}
              >
                Delete Tab
              </button>
              <button
                className="topbar-dropdown-item"
                onClick={() => handleMenuAction(() => openSettings("controls"))}
              >
                Settings
              </button>
              <button
                className="topbar-dropdown-item"
                onClick={() => handleMenuAction(() => void handleOpenServersWindow())}
              >
                Servers
              </button>
              {!SPEECH_TO_TEXT_DISABLED && (
                <button
                  className="topbar-dropdown-item"
                  onClick={() => handleMenuAction(() => void handleTranscribeAudioFile())}
                >
                  Transcribe Audio File
                </button>
              )}
              <button
                className="topbar-dropdown-item"
                onClick={() => handleMenuAction(() => void handleCheckForUpdates())}
                disabled={isCheckingForUpdates}
              >
                {isCheckingForUpdates
                  ? "Checking for Updates..."
                  : availableUpdateVersion
                    ? `Update Available (${availableUpdateVersion})`
                    : "Check for Updates"}
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="tab-surfaces">
        {tabs.map((tab) => {
          const snapshot =
            tab.id === activeTabId
              ? buildSnapshot(
                  projectPath,
                  workspaceName,
                  panes,
                  activeId,
                  lastSplit,
                  fixedGridLayoutId,
                )
              : tab.snapshot;
          if (!snapshot) return null;

          const tabPanes: Pane[] = snapshot.panes.map((pane, index) => ({
            id: pane.id,
            name: pane.name || `Terminal ${index + 1}`,
          }));
          const tabFixedGrid =
            snapshot.gridLayoutId &&
            tabPanes.length <= getGridCapacity(getGridLayout(snapshot.gridLayoutId))
              ? getGridLayout(snapshot.gridLayoutId)
              : null;
          const tabGrid = tabFixedGrid
            ? { rows: tabFixedGrid.rows, cols: tabFixedGrid.cols }
            : getGrid(tabPanes.length, snapshot.lastSplit ?? "horizontal");
          const isTabActive = tab.id === activeTabId;

          return (
            <section
              key={tab.id}
              className={`grid tab-surface ${isTabActive ? "active" : "hidden"}`}
              style={{
                gridTemplateColumns: `repeat(${tabGrid.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${tabGrid.rows}, minmax(0, 1fr))`,
              }}
            >
              {tabPanes.map((pane) => (
                <TerminalPane
                  key={pane.id}
                  id={pane.id}
                  activityVariant={getNextActivityVariant()}
                  layoutTick={layoutTick}
                  isActive={isTabActive && pane.id === activeId}
                  isDropTarget={isTabActive && isImageDragActive && dropTargetPaneId === pane.id}
                  onSelect={isTabActive ? (id) => setActiveId(id) : () => undefined}
                  onClose={isTabActive ? handleClose : () => undefined}
                  canClose={isTabActive && tabPanes.length > 1}
                  cwd={snapshot.projectPath}
                  startupCommand={isTabActive ? startupCommands[pane.id] : undefined}
                  onStartupCommandConsumed={
                    isTabActive ? handleStartupCommandConsumed : () => undefined
                  }
                />
              ))}
            </section>
          );
        })}
      </div>

      {isSpeechOverlayVisible && (
        <div className={`speech-overlay speech-${speechCaptureState}`}>
          <div className="speech-wave" aria-hidden>
            {speechWaveLevels.map((level, index) => (
              <span
                // Index is stable because the bar count is fixed.
                key={index}
                style={{
                  height: `${Math.round(2 + level * 7)}px`,
                  opacity: 0.46 + level * 0.54,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {workspaceSetupModal}

      {isSettingsOpen && (
        <div className="modal-backdrop" onClick={closeSettings}>
          <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Settings</div>
                <div className="modal-subtitle">{activeSettingsMeta.description}</div>
              </div>
              <button
                className="btn"
                onClick={closeSettings}
                aria-label="Close settings"
              >
                ×
              </button>
            </div>
            <div className="modal-body settings-layout">
              <aside className="settings-sidebar">
                {SETTINGS_SECTIONS.map((section) => (
                  <button
                    key={section.id}
                    className={`settings-nav-item ${
                      activeSettingsSection === section.id ? "active" : ""
                    }`}
                    onClick={() => setActiveSettingsSection(section.id)}
                  >
                    <span className="settings-nav-label">{section.label}</span>
                    <span className="settings-nav-description">{section.description}</span>
                  </button>
                ))}
              </aside>
              <section className="settings-panel">
                {activeSettingsSection === "ui" && (
                  <div className="settings-section">
                    <div className="settings-section-title">UI Presets</div>
                    <div className="settings-section-subtitle">
                      Choose a full app UI pack. Each preset updates theme, layout, and
                      interaction behavior together.
                    </div>
                    <div className="ui-preset-grid">
                      {UI_PRESET_OPTIONS.map((preset) => (
                        <button
                          key={preset.id}
                          className={`ui-preset-card ${
                            draftAppearanceSettings.uiPreset === preset.id ? "active" : ""
                          }`}
                          onClick={() => handleSelectUiPreset(preset.id)}
                        >
                          <span className="ui-preset-label">
                            {preset.label}
                            {preset.id === "default" ? " (Default)" : ""}
                          </span>
                          <span className="ui-preset-description">{preset.description}</span>
                          <span className="ui-preset-preview">{preset.preview}</span>
                        </button>
                      ))}
                    </div>
                    <div className="settings-card">
                      <div className="settings-card-title">Current selection</div>
                      <div className="settings-card-text">
                        {UI_PRESET_OPTIONS.find(
                          (preset) => preset.id === draftAppearanceSettings.uiPreset,
                        )?.label ?? "Default"}
                      </div>
                    </div>
                  </div>
                )}

                {activeSettingsSection === "appearance" && (
                  <div className="settings-section">
                    <div className="settings-section-title">Appearance</div>
                    <div className="settings-section-subtitle">
                      Configure the full app theme and layout style.
                    </div>
                    <label className="field settings-field">
                      <span>App Theme</span>
                      <select
                        value={draftAppearanceSettings.appTheme}
                        onChange={(event) =>
                          setDraftAppearanceSettings((current) => ({
                            ...current,
                            appTheme: event.target.value as AppTheme,
                          }))
                        }
                      >
                        <option value="carbon-black">Carbon Black (Default)</option>
                        <option value="onyx-terminal">Onyx Terminal</option>
                        <option value="void-slate">Void Slate</option>
                        <option value="obsidian">Obsidian Flux</option>
                        <option value="neon-noir">Neon Noir</option>
                        <option value="ember-graphite">Ember Graphite</option>
                        <option value="ocean-steel">Ocean Steel</option>
                        <option value="forest-night">Forest Night</option>
                      </select>
                    </label>
                    <label className="field settings-field">
                      <span>Layout Style</span>
                      <select
                        value={draftAppearanceSettings.appLayout}
                        onChange={(event) =>
                          setDraftAppearanceSettings((current) => ({
                            ...current,
                            appLayout: event.target.value as AppLayout,
                          }))
                        }
                      >
                        <option value="terminal-dense">Terminal Dense</option>
                        <option value="clean">Clean</option>
                        <option value="compact">Compact</option>
                        <option value="spacious">Spacious</option>
                        <option value="focus-wide">Focus Wide</option>
                      </select>
                    </label>
                    <div className="settings-card">
                      <div className="settings-card-title">Theme Direction</div>
                      <div className="settings-card-text">
                        All themes are dark-first and optimized for long terminal sessions.
                      </div>
                    </div>
                    <label className="field settings-field">
                      <span>Activity line speed</span>
                      <select
                        value={draftAppearanceSettings.activityMotion}
                        onChange={(event) =>
                          setDraftAppearanceSettings((current) => ({
                            ...current,
                            activityMotion: event.target.value as AppearanceSettings["activityMotion"],
                          }))
                        }
                      >
                        <option value="fast">Fast</option>
                        <option value="balanced">Balanced</option>
                        <option value="slow">Slow</option>
                      </select>
                    </label>
                    <label className="field settings-field">
                      <span>Close button visibility</span>
                      <select
                        value={draftAppearanceSettings.closeButtonMode}
                        onChange={(event) =>
                          setDraftAppearanceSettings((current) => ({
                            ...current,
                            closeButtonMode:
                              event.target.value as AppearanceSettings["closeButtonMode"],
                          }))
                        }
                      >
                        <option value="hover">Show on hover</option>
                        <option value="always">Always visible</option>
                      </select>
                    </label>
                    <div className="settings-card">
                      <div className="settings-card-title">Terminal activity variants</div>
                      <div className="settings-card-text">
                        25 animated color combos are automatically distributed across open terminals.
                      </div>
                    </div>
                  </div>
                )}

                {activeSettingsSection === "controls" && (
                  <div className="settings-section">
                    <div className="settings-section-title">Controls</div>
                    <div className="settings-section-subtitle">
                      Configure split shortcuts and image drop behavior.
                    </div>
                    <label className="field settings-field">
                      <span>Split horizontal</span>
                      <div className="field-input">
                        <span className="field-prefix">Ctrl +</span>
                        <input
                          value={draftShortcuts.splitHorizontalKey.toUpperCase()}
                          onChange={(event) =>
                            handleShortcutChange(
                              "splitHorizontalKey",
                              event.target.value,
                            )
                          }
                          maxLength={1}
                        />
                      </div>
                    </label>
                    <label className="field settings-field">
                      <span>Split vertical</span>
                      <div className="field-input">
                        <span className="field-prefix">Ctrl +</span>
                        <input
                          value={draftShortcuts.splitVerticalKey.toUpperCase()}
                          onChange={(event) =>
                            handleShortcutChange(
                              "splitVerticalKey",
                              event.target.value,
                            )
                          }
                          maxLength={1}
                        />
                      </div>
                    </label>
                    <label className="field settings-field">
                      <span>Image drop format</span>
                      <select
                        value={draftShortcuts.imageDropFormat}
                        onChange={(event) =>
                          handleImageDropFormatChange(
                            event.target.value as ShortcutSettings["imageDropFormat"],
                          )
                        }
                      >
                        <option value="single-line">Single line</option>
                        <option value="separate-lines">Separate lines</option>
                      </select>
                    </label>
                    <div className="field-hint">
                      Multiple dropped images can be inserted in one line or one path per line.
                    </div>
                    <div className="field-hint">
                      Speech-to-text is currently disabled.
                    </div>
                    {draftShortcuts.splitHorizontalKey.toLowerCase() === "v" ||
                    draftShortcuts.splitVerticalKey.toLowerCase() === "v" ? (
                      <div className="field-hint">
                        Using Ctrl+V will override paste in terminals.
                      </div>
                    ) : null}
                    {shortcutError && <div className="field-error">{shortcutError}</div>}
                  </div>
                )}

                {activeSettingsSection === "workspace" && (
                  <div className="settings-section">
                    <div className="settings-section-title">Workspace Defaults</div>
                    <div className="settings-section-subtitle">
                      Applied when opening a new workspace setup flow.
                    </div>
                    <label className="field settings-field">
                      <span>Default workspace name</span>
                      <input
                        value={draftWorkspacePreferences.defaultWorkspaceName}
                        onChange={(event) =>
                          setDraftWorkspacePreferences((current) => ({
                            ...current,
                            defaultWorkspaceName: event.target.value,
                          }))
                        }
                        placeholder="Workspace"
                      />
                    </label>
                    <label className="field settings-field">
                      <span>Default grid layout</span>
                      <select
                        value={draftWorkspacePreferences.defaultGridLayoutId}
                        onChange={(event) =>
                          setDraftWorkspacePreferences((current) => ({
                            ...current,
                            defaultGridLayoutId: event.target.value,
                          }))
                        }
                      >
                        {GRID_LAYOUT_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label} ({getGridCapacity(option)} panes)
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {activeSettingsSection === "updates" && (
                  <div className="settings-section">
                    <div className="settings-section-title">Updates</div>
                    <div className="settings-section-subtitle">
                      Check for new releases and install updates inside the app.
                    </div>
                    <div className="settings-card">
                      <div className="settings-card-title">Current status</div>
                      <div className="settings-card-text">
                        {availableUpdateVersion
                          ? `Update available: v${availableUpdateVersion}`
                          : "No pending update detected in this session."}
                      </div>
                    </div>
                    <button
                      className="btn secondary settings-inline-action"
                      onClick={() => void handleCheckForUpdates()}
                      disabled={isCheckingForUpdates}
                    >
                      {isCheckingForUpdates ? "Checking..." : "Check for Updates"}
                    </button>
                  </div>
                )}
              </section>
            </div>
            <div className="modal-actions">
              <button className="btn secondary" onClick={closeSettings}>
                Cancel
              </button>
              {activeSettingsSection === "controls" && (
                <button className="btn primary" onClick={handleSaveShortcuts}>
                  Save Controls
                </button>
              )}
              {activeSettingsSection === "appearance" && (
                <button className="btn primary" onClick={handleSaveAppearance}>
                  Save Appearance
                </button>
              )}
              {activeSettingsSection === "ui" && (
                <button className="btn primary" onClick={handleSaveAppearance}>
                  Save UI
                </button>
              )}
              {activeSettingsSection === "workspace" && (
                <button className="btn primary" onClick={handleSaveWorkspacePreferences}>
                  Save Workspace
                </button>
              )}
              {activeSettingsSection === "updates" && (
                <button className="btn primary" onClick={closeSettings}>
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {isPaletteOpen && (
        <div className="modal-backdrop" onClick={() => setIsPaletteOpen(false)}>
          <div className="palette" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              className="palette-input"
              placeholder="Type a command… (use > to run)"
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
            />
            <div className="palette-list">
              {filteredPaletteActions.length === 0 ? (
                <div className="palette-empty">No matches</div>
              ) : (
                filteredPaletteActions.map((action) => (
                  <button
                    key={action.id}
                    className="palette-item"
                    onClick={action.run}
                  >
                    <span>{action.label}</span>
                    {action.hint && (
                      <span className="palette-hint">{action.hint}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {isServersInline && (
        <div
          className="modal-backdrop"
          onClick={() => setIsServersInline(false)}
        >
          <div
            className="modal server-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="modal-title">Servers</div>
                <div className="modal-subtitle">
                  Manage servers without leaving this window.
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setIsServersInline(false)}
                aria-label="Close servers"
              >
                ×
              </button>
            </div>
            <div className="modal-body server-embed">
              <ServerManager embedded />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  const view =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("view")
      : null;
  if (view === "servers") {
    return <ServerManager />;
  }
  return <MainApp />;
}

export default App;

