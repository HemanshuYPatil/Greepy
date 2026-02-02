import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type PtyDataEvent = {
  id: string;
  data: string;
};

type Pane = {
  id: string;
};

let ptyCreateQueue: Promise<void> = Promise.resolve();

const enqueuePtyCreate = (task: () => Promise<void>) => {
  const next = ptyCreateQueue.then(task, task);
  ptyCreateQueue = next.catch(() => undefined);
  return next;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_SPLITS = 6;

const createPane = (): Pane => ({
  id:
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `pane-${Math.random().toString(36).slice(2, 10)}`,
});

type TerminalPaneProps = {
  id: string;
  layoutTick: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  canClose: boolean;
  cwd: string;
};

function TerminalPane({
  id,
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

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let windowResizeHandler: (() => void) | null = null;
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
          if (key === "d" || key === "v" || key === "w") return false;
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
      if (termRef.current) termRef.current.dispose();
      termRef.current = null;
      fitRef.current = null;
      void invoke("pty_close", { id });
    };
  }, [id, cwd]);

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
    <div className={`tile ${isActive ? "active" : ""}`} onClick={() => onSelect(id)}>
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

function App() {
  const [panes, setPanes] = useState<Pane[]>(() => [createPane()]);
  const [activeId, setActiveId] = useState<string>(() => panes[0].id);
  const [layoutTick, setLayoutTick] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [isProjectReady, setIsProjectReady] = useState(false);
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

  const handleChooseProject = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Project Folder",
    });
    if (typeof selected === "string" && selected.trim()) {
      setProjectPath(selected);
      setIsProjectReady(true);
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
      if (key !== "d" && key !== "v" && key !== "w") return;

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
        next.splice(insertIndex, 0, createPane());
        setLastSplit(key === "d" ? "horizontal" : "vertical");
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
        <div className="command-hints" data-tauri-drag-region>
          <span>Ctrl+D split horizontal</span>
          <span>Ctrl+V split vertical</span>
          <span>Ctrl+W close</span>
          <span>F11 fullscreen</span>
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
            layoutTick={layoutTick}
            isActive={pane.id === activeId}
            onSelect={(id) => setActiveId(id)}
            onClose={handleClose}
            canClose={panes.length > 1}
            cwd={projectPath}
          />
        ))}
      </section>
    </div>
  );
}

export default App;
