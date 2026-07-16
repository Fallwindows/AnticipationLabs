import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Electron entry. Renderer is fully sandboxed: contextIsolation on, nodeIntegration
 * off — the UI talks to the core over localhost HTTP/WS only. If the core service is
 * not already running we optionally spawn the built core (best effort, never fatal).
 */

const CORE_HEALTH_URL = 'http://127.0.0.1:4271/api/health';
const DEV = process.env.ELECTRON_DEV === '1';

let coreProcess: ChildProcess | null = null;

async function coreIsReachable(): Promise<boolean> {
  try {
    const res = await fetch(CORE_HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureCoreRunning(): Promise<void> {
  if (await coreIsReachable()) return;
  // dist-electron/ -> packages/shell -> packages/core/dist/main.js
  const coreEntry = path.resolve(__dirname, '..', '..', 'core', 'dist', 'main.js');
  if (!existsSync(coreEntry)) return; // core not built; the shell will show "reconnecting"
  try {
    coreProcess = spawn(process.execPath, [coreEntry], {
      cwd: path.dirname(coreEntry),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    });
    coreProcess.on('exit', () => {
      coreProcess = null;
    });
  } catch {
    coreProcess = null;
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0a0d13',
    title: 'Anticipy — Operator Console',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (DEV) {
    void window.loadURL('http://localhost:5173');
  } else {
    void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

void app.whenReady().then(async () => {
  await ensureCoreRunning();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (coreProcess && !coreProcess.killed) coreProcess.kill();
});
