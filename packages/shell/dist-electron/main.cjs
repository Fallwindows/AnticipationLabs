"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// electron/main.ts
var import_electron = require("electron");
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"), 1);
var CORE_HEALTH_URL = "http://127.0.0.1:4271/api/health";
var DEV = process.env.ELECTRON_DEV === "1";
var coreProcess = null;
async function coreIsReachable() {
  try {
    const res = await fetch(CORE_HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
async function ensureCoreRunning() {
  if (await coreIsReachable()) return;
  const coreEntry = import_node_path.default.resolve(__dirname, "..", "..", "core", "dist", "main.js");
  if (!(0, import_node_fs.existsSync)(coreEntry)) return;
  try {
    coreProcess = (0, import_node_child_process.spawn)(process.execPath, [coreEntry], {
      cwd: import_node_path.default.dirname(coreEntry),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore"
    });
    coreProcess.on("exit", () => {
      coreProcess = null;
    });
  } catch {
    coreProcess = null;
  }
}
function createWindow() {
  const window = new import_electron.BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1e3,
    minHeight: 640,
    backgroundColor: "#0a0d13",
    title: "Anticipy \u2014 Operator Console",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: import_node_path.default.join(__dirname, "preload.cjs")
    }
  });
  if (DEV) {
    void window.loadURL("http://localhost:5173");
  } else {
    void window.loadFile(import_node_path.default.join(__dirname, "..", "dist", "index.html"));
  }
}
void import_electron.app.whenReady().then(async () => {
  await ensureCoreRunning();
  createWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") import_electron.app.quit();
});
import_electron.app.on("before-quit", () => {
  if (coreProcess && !coreProcess.killed) coreProcess.kill();
});
