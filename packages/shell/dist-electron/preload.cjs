"use strict";

// electron/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("anticipyShell", {
  platform: process.platform,
  coreUrl: "http://127.0.0.1:4271",
  version: process.env.npm_package_version ?? "0.1.0"
});
