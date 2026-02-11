import { useEffect, useMemo, useRef, useState } from "react";
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

const DEFAULT_SHORTCUTS: ShortcutSettings = {
  splitHorizontalKey: "d",
  splitVerticalKey: "b",
};

const normalizeShortcutKey = (value: string) =>
  value.trim().toLowerCase().slice(0, 1);

const RECENTS_KEY = "greepy.recentProjects";
const MAX_RECENTS = 6;
const SESSION_KEY = "greepy.lastSession";
const SERVERS_KEY = "greepy.projectServers";
const LAST_PROJECT_KEY = "greepy.lastProject";
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

const getGridLayout = (id: string) =>
  GRID_LAYOUT_OPTIONS.find((option) => option.id === id) ?? GRID_LAYOUT_OPTIONS[0];

const getGridCapacity = (layout: GridLayoutOption) => layout.rows * layout.cols;

const getFolderName = (path: string) => {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
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

const loadSession = (): SessionSnapshot | null => {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SessionSnapshot;
    if (!parsed.projectPath || !parsed.panes?.length) return null;
    return parsed;
  } catch {
    return null;
  }
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
    if (!splitHorizontalKey || !splitVerticalKey) return DEFAULT_SHORTCUTS;
    return { splitHorizontalKey, splitVerticalKey };
  } catch {
    return DEFAULT_SHORTCUTS;
  }
};

const saveShortcuts = (shortcuts: ShortcutSettings) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("greepy.shortcuts", JSON.stringify(shortcuts));
};

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

const createPane = (index: number): Pane => ({
  id: createRuntimeId("pane"),
  name: `Terminal ${index}`,
});

type TerminalPaneProps = {
  id: string;
  name: string;
  onRename: (id: string, name: string) => void;
  layoutTick: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  canClose: boolean;
  cwd: string;
  startupCommand?: string;
  onStartupCommandConsumed: (id: string) => void;
};

function TerminalPane({
  id,
  name,
  onRename,
  layoutTick,
  isActive,
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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleTileClick = () => {
    onSelect(id);
    termRef.current?.focus();
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let windowResizeHandler: (() => void) | null = null;
    let pasteHandler: ((event: ClipboardEvent) => void) | null = null;
    let disposed = false;

    const setup = async () => {
      if (!containerRef.current) return;

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
      term.open(containerRef.current);
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
      });

      pasteHandler = (event: ClipboardEvent) => {
        event.preventDefault();
        void (async () => {
          try {
            const text = await readClipboardText();
            if (text) {
              await invoke("pty_write", { id, data: text });
            }
          } catch {
            const text = event.clipboardData?.getData("text");
            if (!text) return;
            await invoke("pty_write", { id, data: text });
          }
        })();
      };

      containerRef.current.addEventListener("paste", pasteHandler);

      unlisten = await listen<PtyDataEvent>("pty:data", (event) => {
        if (event.payload.id === id) {
          setIsLoading(false);
          term.write(event.payload.data);
        }
      });

      const handleResize = () => {
        fitAddon.fit();
        void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
      };

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(containerRef.current);
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
      if (termRef.current) termRef.current.dispose();
      termRef.current = null;
      fitRef.current = null;
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
    <div className={`tile ${isActive ? "active" : ""}`} onClick={handleTileClick}>
      <div className="tile-header">
        <input
          className="tile-title"
          value={name}
          onChange={(event) => onRename(id, event.target.value)}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
      <div className="tile-actions">
        <button
          className="btn"
          onClick={(event) => {
            event.stopPropagation();
            onClose(id);
          }}
          disabled={!canClose}
          title={canClose ? "Close terminal" : "At least one terminal required"}
        >
          ×
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
      <div className="terminal-shell" ref={containerRef} />
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
  const [workspaceName, setWorkspaceName] = useState("Workspace");
  const [fixedGridLayoutId, setFixedGridLayoutId] = useState<string | null>(null);
  const [startupCommands, setStartupCommands] = useState<Record<string, string>>({});
  const [isProjectReady, setIsProjectReady] = useState(false);
  const [isWorkspaceSetupOpen, setIsWorkspaceSetupOpen] = useState(false);
  const [workspaceSetupMode, setWorkspaceSetupMode] =
    useState<WorkspaceSetupMode>("active-tab");
  const [workspaceSetupError, setWorkspaceSetupError] = useState<string | null>(null);
  const [workspaceSetupForm, setWorkspaceSetupForm] = useState<WorkspaceSetupForm>({
    workspaceName: "Workspace",
    projectPath: loadLastProject(),
    gridLayoutId: DEFAULT_GRID_LAYOUT_ID,
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
  const [shortcuts, setShortcuts] = useState<ShortcutSettings>(() =>
    loadShortcuts(),
  );
  const [draftShortcuts, setDraftShortcuts] = useState<ShortcutSettings>(
    shortcuts,
  );
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
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
    setShortcutError(null);
  }, [isSettingsOpen, shortcuts]);

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
      seedName || getFolderName(currentPath) || workspaceName || "Workspace";
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
          ? DEFAULT_GRID_LAYOUT_ID
          : fixedGridLayoutId ?? current.gridLayoutId,
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

  const handleRename = (id: string, name: string) => {
    setPanes((current) =>
      current.map((pane) => (pane.id === id ? { ...pane, name } : pane)),
    );
  };

  const handleRunCommand = async (command: string) => {
    if (!isProjectReady || !activeId) return;
    await invoke("pty_write", { id: activeId, data: `${command}\r` });
  };

  const handleShortcutChange = (
    field: keyof ShortcutSettings,
    value: string,
  ) => {
    const next = { ...draftShortcuts, [field]: normalizeShortcutKey(value) };
    setDraftShortcuts(next);
    setShortcutError(null);
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

    const next = { splitHorizontalKey, splitVerticalKey };
    setShortcuts(next);
    saveShortcuts(next);
    setIsSettingsOpen(false);
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

  const formatErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  const handleCheckForUpdates = async (silent = false) => {
    if (isCheckingForUpdates) return;
    setIsCheckingForUpdates(true);
    let update: Awaited<ReturnType<typeof check>> = null;
    try {
      update = await check();
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
      if (!silent) {
        await message(`Unable to check for updates.\n\n${formatErrorMessage(error)}`, {
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
            setIsSettingsOpen(true);
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

  if (!isProjectReady) {
    return (
      <div className="app">
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
            {loadSession() && (
              <button
                className="btn secondary"
                onClick={() => {
                  const snapshot = loadSession();
                  if (!snapshot) return;
                  startupCommandExecuted.clear();
                  setProjectPath(snapshot.projectPath);
                  setWorkspaceName(
                    snapshot.workspaceName?.trim() ||
                      getFolderName(snapshot.projectPath) ||
                      "Workspace",
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
                  setStartupCommands({});
                  setIsMenuOpen(false);
                  saveLastProject(snapshot.projectPath);
                  updateRecentProjects(snapshot.projectPath);
                }}
              >
                Resume last session
              </button>
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

  return (
    <div className={`app ${isFullscreen ? "fullscreen" : ""}`}>
      <header className="topbar">
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
        <div className="topbar-drag-zone" />
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
                onClick={() => handleMenuAction(() => setIsSettingsOpen(true))}
              >
                Settings
              </button>
              <button
                className="topbar-dropdown-item"
                onClick={() => handleMenuAction(() => void handleOpenServersWindow())}
              >
                Servers
              </button>
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
                  name={pane.name}
                  onRename={isTabActive ? handleRename : () => undefined}
                  layoutTick={layoutTick}
                  isActive={isTabActive && pane.id === activeId}
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

      {workspaceSetupModal}

      {isSettingsOpen && (
        <div className="modal-backdrop" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Settings</div>
                <div className="modal-subtitle">
                  Choose your split shortcuts (Ctrl + letter).
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Close settings"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <label className="field">
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
              <label className="field">
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
              {draftShortcuts.splitHorizontalKey.toLowerCase() === "v" ||
              draftShortcuts.splitVerticalKey.toLowerCase() === "v" ? (
                <div className="field-hint">
                  Using Ctrl+V will override paste in terminals.
                </div>
              ) : null}
              {shortcutError && <div className="field-error">{shortcutError}</div>}
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={handleSaveShortcuts}>
                Save
              </button>
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
