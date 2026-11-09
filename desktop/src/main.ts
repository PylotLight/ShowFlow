// Showfish: a read-only desktop viewer for a ShowFlow backup.
//
// Spawns the ShowFlow server with SHOWFLOW_LOCAL_VIEW=1 (no scheduler,
// downloads, imports, updates or backups; mutating API calls are refused, see
// src/backend/core/local_view.ts) on a loopback port, with its data dir under
// userData, and shows the UI in a window. File › Open Backup… swaps in a
// different .db.

import { app, BrowserWindow, Menu, dialog, shell, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, copyFileSync, rmSync, openSync, readSync, closeSync, cpSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

const APP_NAME = "Showfish";
app.setName(APP_NAME);

const dataDir = join(app.getPath("userData"), "data");
const dbPath = join(dataDir, "showflow.db");
const logPath = join(dataDir, "server.log");

let win: BrowserWindow | null = null;
let server: ChildProcess | null = null;
let serverUrl = "";
let quitting = false;

// ---- server ---------------------------------------------------------------

// A fixed preferred port keeps the UI's origin (and so its localStorage)
// stable between launches; any free port if it's taken.
const PREFERRED_PORT = 47820;

async function freePort(): Promise<number> {
  return (await tryPort(PREFERRED_PORT).catch(() => 0)) || tryPort(0);
}

function tryPort(want: number): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on("error", fail);
    s.listen(want, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

/** The command that runs the ShowFlow server. */
function serverCommand(): { cmd: string; args: string[] } {
  if (app.isPackaged) {
    // `bun build --compile` binary (scripts/build-server.ts), migrations beside it.
    return { cmd: join(process.resourcesPath, "server", "showflow-server"), args: [] };
  }
  // Dev: system bun against the repo's source. `electron .` in desktop/ makes
  // the app path desktop/, so the repo root is one up. (Not __dirname: bun
  // build inlines it at build time.)
  const repo = resolve(app.getAppPath(), "..");
  const candidates = [
    process.env.BUN_PATH,
    join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter((p): p is string => !!p);
  const bun = candidates.find((p) => existsSync(p)) ?? "bun";
  return { cmd: bun, args: [join(repo, "src", "backend", "server.ts")] };
}

function log(line: string) {
  try { appendFileSync(logPath, line); } catch {}
}

async function waitReady(url: string, child: ChildProcess, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server exited (code ${child.exitCode}), see ${logPath}`);
    try {
      const r = await fetch(`${url}/internal/ready`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become ready in ${timeoutMs / 1000}s, see ${logPath}`);
}

async function startServer() {
  mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const { cmd, args } = serverCommand();
  log(`\n--- ${new Date().toISOString()} starting ${cmd} ${args.join(" ")} on :${port}\n`);
  const child = spawn(cmd, args, {
    cwd: dataDir, // showflow.db is cwd-relative
    env: {
      ...process.env,
      SHOWFLOW_LOCAL_VIEW: "1",
      SHOWFLOW_DATA_DIR: dataDir,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => log(String(d)));
  child.stderr?.on("data", (d) => log(String(d)));
  child.on("exit", (code, signal) => {
    log(`--- server exited code=${code} signal=${signal}\n`);
    if (server === child) {
      server = null;
      if (!quitting) {
        dialog.showErrorBox(APP_NAME, `The ShowFlow server stopped unexpectedly.\n\nLog: ${logPath}`);
      }
    }
  });
  server = child;
  const url = `http://127.0.0.1:${port}`;
  await waitReady(url, child);
  serverUrl = url;
}

function stopServer(): Promise<void> {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 4000);
    child.once("exit", () => { clearTimeout(kill); done(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(kill); done(); }
  });
}

// ---- backup restore ---------------------------------------------------------

function isSqlite(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    closeSync(fd);
    return buf.toString("latin1") === "SQLite format 3\0";
  } catch {
    return false;
  }
}

/**
 * Same steps as the server's restore (DatabaseManager.replaceFile +
 * core/backup.ts restoreBackup), done here because the server is stopped:
 * drop the -wal/-shm companions so a stale WAL never replays over the new
 * file, copy the backup in as showflow.db, then bring back artwork from a
 * sibling backups/images store if there is one. Missing artwork re-warms from
 * the providers. Migrations run when the server starts on it.
 */
function restoreInto(src: string) {
  mkdirSync(dataDir, { recursive: true });
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  copyFileSync(src, dbPath);
  const store = join(dirname(src), "images");
  if (existsSync(store)) {
    try {
      cpSync(store, join(dataDir, "images"), { recursive: true, force: false, errorOnExist: false });
    } catch (err) {
      log(`[restore] could not copy images: ${err}\n`);
    }
  }
}

async function pickBackup(): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: "Open ShowFlow Backup",
    message: "Choose a ShowFlow database backup (.db)",
    properties: ["openFile"],
    filters: [{ name: "ShowFlow backup", extensions: ["db", "sqlite", "sqlite3"] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const file = res.filePaths[0];
  if (res.canceled || !file) return null;
  if (!isSqlite(file)) {
    dialog.showErrorBox(APP_NAME, `${file}\n\nisn't a SQLite database.`);
    return null;
  }
  return file;
}

async function openBackup() {
  const file = await pickBackup();
  if (!file) return;
  showLoading("Loading backup…");
  await stopServer();
  try {
    restoreInto(file);
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `Could not copy the backup: ${err instanceof Error ? err.message : err}`);
  }
  await boot();
}

// ---- window -----------------------------------------------------------------

// Make the hiddenInset title bar work without touching the web UI: the
// sidebar top clears the traffic lights, header + sidebar drag the window.
const CHROME_CSS = `
  aside.glass-panel { padding-top: 40px !important; -webkit-app-region: drag; }
  header { -webkit-app-region: drag; }
  aside.glass-panel a, aside.glass-panel button, aside.glass-panel input,
  header a, header button, header input, header select, header [role="button"], header [data-header-row] {
    -webkit-app-region: no-drag;
  }
`;

function loadingHtml(text: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#8a93a6;font:13px -apple-system,system-ui;-webkit-app-region:drag">${text}</body></html>`)}`;
}

function showLoading(text: string) {
  void win?.loadURL(loadingHtml(text));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0b0d12",
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => { win = null; });
  win.webContents.on("did-finish-load", () => {
    if (serverUrl && win?.webContents.getURL().startsWith(serverUrl)) {
      win.webContents.insertCSS(CHROME_CSS).catch(() => {});
    }
  });
  // External links open in the browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!serverUrl || !url.startsWith(serverUrl)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (serverUrl && !url.startsWith(serverUrl) && !url.startsWith("data:")) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  showLoading("Starting ShowFlow…");
}

async function boot() {
  if (!existsSync(dbPath)) {
    const choice = await dialog.showMessageBox({
      type: "info",
      message: "Open a ShowFlow backup",
      detail: "Showfish shows a ShowFlow database backup (.db) read-only. Nothing downloads, imports or syncs.",
      buttons: ["Open Backup…", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return app.quit();
    const file = await pickBackup();
    if (!file) return app.quit();
    restoreInto(file);
  }
  showLoading("Starting ShowFlow…");
  try {
    await startServer();
    await win?.loadURL(serverUrl);
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `Could not start the ShowFlow server.\n\n${err instanceof Error ? err.message : err}`);
  }
}

// ---- menu -------------------------------------------------------------------

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Open Backup…", accelerator: "CmdOrCtrl+O", click: () => { void openBackup(); } },
        { type: "separator" },
        { label: "Reveal Data Folder", click: () => { mkdirSync(dataDir, { recursive: true }); void shell.openPath(dataDir); } },
        { label: "Show Server Log", click: () => { if (existsSync(logPath)) shell.showItemInFolder(logPath); } },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- lifecycle --------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  void app.whenReady().then(async () => {
    buildMenu();
    createWindow();
    await boot();
  });

  app.on("activate", () => {
    if (!win) {
      createWindow();
      if (serverUrl) void win!.loadURL(serverUrl);
    }
  });

  app.on("window-all-closed", () => app.quit());

  // Kill the server on quit (SIGTERM, SIGKILL after 4s).
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true;
    if (server) {
      e.preventDefault();
      void stopServer().finally(() => app.quit());
    }
  });
}
