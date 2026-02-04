import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  panes: Array<{ id: string; name: string }>;
  activeId: string;
  lastSplit: "horizontal" | "vertical";
  updatedAt: number;
};

type CommandEntry = {
  id: string;
  label: string;
  command: string;
};

type ServerEntry = {
  id: string;
  name: string;
  command: string;
  autostart: boolean;
};

const DEFAULT_SHORTCUTS: ShortcutSettings = {
  splitHorizontalKey: "d",
  splitVerticalKey: "b",
};

const normalizeShortcutKey = (value: string) =>
  value.trim().toLowerCase().slice(0, 1);

const RECENTS_KEY = "greepy.recentProjects";
const MAX_RECENTS = 6;
const SESSION_KEY = "greepy.lastSession";
const COMMANDS_KEY = "greepy.projectCommands";
const SERVERS_KEY = "greepy.projectServers";
const LAST_PROJECT_KEY = "greepy.lastProject";
const DEFAULT_COMMANDS: CommandEntry[] = [
  { id: "cmd-dev", label: "Run dev server", command: "pnpm dev" },
  { id: "cmd-test", label: "Run tests", command: "pnpm test" },
  { id: "cmd-status", label: "Git status", command: "git status" },
];

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

const loadCommandsMap = (): Record<string, CommandEntry[]> => {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(COMMANDS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, CommandEntry[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const saveCommandsMap = (map: Record<string, CommandEntry[]>) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COMMANDS_KEY, JSON.stringify(map));
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

const enqueuePtyCreate = (task: () => Promise<void>) => {
  const next = ptyCreateQueue.then(task, task);
  ptyCreateQueue = next.catch(() => undefined);
  return next;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_SPLITS = 6;

const createPane = (index: number): Pane => ({
  id:
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `pane-${Math.random().toString(36).slice(2, 10)}`,
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
  const appWindow = useMemo(
    () => (embedded ? null : getCurrentWindow()),
    [embedded],
  );

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
      <header className="topbar" data-tauri-drag-region>
        <div className="server-topbar" data-tauri-drag-region>
          <div className="server-topbar-text">
            <div className="server-topbar-title">Server Manager</div>
            <div className="server-topbar-path">
              {projectPath || "No project selected"}
            </div>
          </div>
          <div className="server-topbar-actions" data-tauri-drag-region="false">
            <button className="btn secondary" onClick={handleChooseProject}>
              Change Project
            </button>
            {!embedded && appWindow && (
              <button
                className="btn window close"
                onClick={() => void appWindow.close()}
              >
                ×
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="server-shell">
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
  const [layoutTick, setLayoutTick] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [isProjectReady, setIsProjectReady] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() =>
    loadRecentProjects(),
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCommandsOpen, setIsCommandsOpen] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [isServersInline, setIsServersInline] = useState(false);
  const [shortcuts, setShortcuts] = useState<ShortcutSettings>(() =>
    loadShortcuts(),
  );
  const [draftShortcuts, setDraftShortcuts] = useState<ShortcutSettings>(
    shortcuts,
  );
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [commandsMap, setCommandsMap] = useState<
    Record<string, CommandEntry[]>
  >(() => loadCommandsMap());
  const [draftCommands, setDraftCommands] = useState<CommandEntry[]>([]);
  const [lastSplit, setLastSplit] = useState<"horizontal" | "vertical">(
    "horizontal",
  );
  const appWindow = useMemo(() => getCurrentWindow(), []);

  useEffect(() => {
    void appWindow.maximize();
  }, [appWindow]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const setup = async () => {
      const current = await appWindow.isMaximized();
      setIsMaximized(current);
      unlisten = await appWindow.onResized(async () => {
        const next = await appWindow.isMaximized();
        setIsMaximized(next);
      });
    };
    void setup();
    return () => {
      if (unlisten) unlisten();
    };
  }, [appWindow]);

  const handleMinimize = () => {
    void appWindow.minimize();
  };

  const handleToggleMaximize = async () => {
    const isMax = await appWindow.isMaximized();
    if (isMax) {
      await appWindow.unmaximize();
      setIsMaximized(false);
    } else {
      await appWindow.maximize();
      setIsMaximized(true);
    }
  };

  const handleCloseWindow = () => {
    void appWindow.close();
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
      panes: panes.map((pane) => ({ id: pane.id, name: pane.name })),
      activeId,
      lastSplit,
      updatedAt: Date.now(),
    });
  }, [projectPath, isProjectReady, panes, activeId, lastSplit]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    setDraftShortcuts(shortcuts);
    setShortcutError(null);
  }, [isSettingsOpen, shortcuts]);

  useEffect(() => {
    if (!isCommandsOpen) return;
    const existing = commandsMap[projectPath] ?? DEFAULT_COMMANDS;
    setDraftCommands(existing.map((item) => ({ ...item })));
  }, [isCommandsOpen, commandsMap, projectPath]);

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
      setIsProjectReady(true);
      const next = [
        { path, lastOpened: Date.now() },
        ...recentProjects.filter((item) => item.path !== path),
      ].slice(0, MAX_RECENTS);
      setRecentProjects(next);
      saveRecentProjects(next);
    }
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
    setPanes((current) => {
      if (current.length <= 1) return current;
      const next = current.filter((pane) => pane.id !== id);
      return next;
    });
    setLayoutTick((tick) => tick + 1);
  };

  const handleRename = (id: string, name: string) => {
    setPanes((current) =>
      current.map((pane) => (pane.id === id ? { ...pane, name } : pane)),
    );
  };

  const getProjectCommands = (path: string) =>
    commandsMap[path] ?? DEFAULT_COMMANDS;

  const handleRunCommand = async (command: string) => {
    if (!isProjectReady || !activeId) return;
    await invoke("pty_write", { id: activeId, data: `${command}\r` });
  };

  const handleCommandsSave = () => {
    const trimmed = draftCommands
      .map((item) => ({
        ...item,
        label: item.label.trim(),
        command: item.command.trim(),
      }))
      .filter((item) => item.label && item.command);
    const next = { ...commandsMap, [projectPath]: trimmed };
    setCommandsMap(next);
    saveCommandsMap(next);
    setIsCommandsOpen(false);
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
        title: "Greepy Servers",
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

  const paletteActions = useMemo(() => {
    const actions: Array<{
      id: string;
      label: string;
      hint?: string;
      run: () => void;
    }> = [
      {
        id: "open-project",
        label: "Open project folder",
        run: () => {
          void handleChooseProject();
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
        {
          id: "open-commands",
          label: "Manage quick commands",
          run: () => {
            setIsCommandsOpen(true);
            setIsPaletteOpen(false);
          },
        },
      );

      const commands = getProjectCommands(projectPath);
      commands.forEach((entry) => {
        actions.push({
          id: `cmd-${entry.id}`,
          label: entry.label,
          hint: entry.command,
          run: () => {
            void handleRunCommand(entry.command);
            setIsPaletteOpen(false);
          },
        });
      });
    }

    return actions;
  }, [
    activeId,
    commandsMap,
    handleChooseProject,
    isProjectReady,
    projectPath,
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

  if (!isProjectReady) {
    return (
      <div className="app">
        <div className="project-screen">
          <div className="project-shell">
            <div className="project-header">
              <div className="brand-title">Greepy</div>
              <div className="brand-subtitle">
                Modular workspace. Start with a project, then add tools.
              </div>
            </div>
            <div className="project-actions">
              <button className="btn primary" onClick={handleChooseProject}>
                Open Project Folder
              </button>
              {projectPath && <div className="project-path">{projectPath}</div>}
            </div>
            {loadSession() && (
              <button
                className="btn secondary"
                onClick={() => {
                  const snapshot = loadSession();
                  if (!snapshot) return;
                  setProjectPath(snapshot.projectPath);
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
                  saveLastProject(snapshot.projectPath);
                  const next = [
                    { path: snapshot.projectPath, lastOpened: Date.now() },
                    ...recentProjects.filter(
                      (item) => item.path !== snapshot.projectPath,
                    ),
                  ].slice(0, MAX_RECENTS);
                  setRecentProjects(next);
                  saveRecentProjects(next);
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
                      onClick={() => {
                        setProjectPath(project.path);
                        setIsProjectReady(true);
                        const next = [
                          { path: project.path, lastOpened: Date.now() },
                          ...recentProjects.filter(
                            (item) => item.path !== project.path,
                          ),
                        ].slice(0, MAX_RECENTS);
                        setRecentProjects(next);
                        saveRecentProjects(next);
                      }}
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
      </div>
    );
  }

  const grid = getGrid(panes.length, lastSplit);

  return (
    <div className={`app ${isFullscreen ? "fullscreen" : ""}`}>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-title" data-tauri-drag-region>
            Greepy
          </span>
        </div>
        <div className="command-hints" data-tauri-drag-region />
        <div className="topbar-actions" data-tauri-drag-region="false">
          <button
            className="btn secondary"
            onClick={() => setIsCommandsOpen(true)}
            data-tauri-drag-region="false"
          >
            Commands
          </button>
          <button
            className="btn secondary"
            onClick={handleOpenServersWindow}
            data-tauri-drag-region="false"
          >
            Servers
          </button>
          <button
            className="btn secondary"
            onClick={() => setIsSettingsOpen(true)}
            data-tauri-drag-region="false"
          >
            Settings
          </button>
        </div>
        <div className="window-controls" data-tauri-drag-region>
          <button className="btn window minimize" onClick={handleMinimize}>
            _
          </button>
          <button className="btn window maximize" onClick={handleToggleMaximize}>
            {isMaximized ? "❐" : "□"}
          </button>
          <button className="btn window close" onClick={handleCloseWindow}>
            ×
          </button>
        </div>
      </header>

      <div className="command-bar">
        <div className="command-bar-label">Quick Commands</div>
        <div className="command-bar-actions">
          {getProjectCommands(projectPath).map((entry) => (
            <button
              key={entry.id}
              className="btn secondary"
              onClick={() => void handleRunCommand(entry.command)}
              title={entry.command}
            >
              {entry.label}
            </button>
          ))}
          <button
            className="btn secondary"
            onClick={() => setIsCommandsOpen(true)}
          >
            Edit
          </button>
        </div>
      </div>

      <section
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
        }}
      >
        {panes.map((pane) => (
          <TerminalPane
            key={pane.id}
            id={pane.id}
            name={pane.name}
            onRename={handleRename}
            layoutTick={layoutTick}
            isActive={pane.id === activeId}
            onSelect={(id) => setActiveId(id)}
            onClose={handleClose}
            canClose={panes.length > 1}
            cwd={projectPath}
          />
        ))}
      </section>

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

      {isCommandsOpen && (
        <div className="modal-backdrop" onClick={() => setIsCommandsOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Quick Commands</div>
                <div className="modal-subtitle">
                  Add commands for this project.
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setIsCommandsOpen(false)}
                aria-label="Close commands"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              {draftCommands.map((entry, index) => (
                <div className="command-row" key={entry.id}>
                  <input
                    value={entry.label}
                    placeholder="Label"
                    onChange={(event) => {
                      const next = [...draftCommands];
                      next[index] = { ...entry, label: event.target.value };
                      setDraftCommands(next);
                    }}
                  />
                  <input
                    value={entry.command}
                    placeholder="Command"
                    onChange={(event) => {
                      const next = [...draftCommands];
                      next[index] = { ...entry, command: event.target.value };
                      setDraftCommands(next);
                    }}
                  />
                  <button
                    className="btn"
                    onClick={() => {
                      const next = draftCommands.filter(
                        (item) => item.id !== entry.id,
                      );
                      setDraftCommands(next);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="btn secondary"
                onClick={() => {
                  setDraftCommands((current) => [
                    ...current,
                    {
                      id: `cmd-${Date.now()}`,
                      label: "",
                      command: "",
                    },
                  ]);
                }}
              >
                Add command
              </button>
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={handleCommandsSave}>
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
