import { contextBridge } from 'electron';

/**
 * Minimal, read-only bridge. The renderer needs nothing from Node — the core is
 * reached over localhost HTTP/WS — so we expose only static environment info.
 */
contextBridge.exposeInMainWorld('anticipyShell', {
  platform: process.platform,
  coreUrl: 'http://127.0.0.1:4271',
  version: process.env.npm_package_version ?? '0.1.0',
});
