const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
app.setPath(
  "userData",
  path.join(process.env.AIMANAPP_USER_ROOT, "electron-profile"),
);
require(path.join(process.env.AIMANAPP_RUNTIME, "main.cjs"));
let running = false;
let retries = 0;
ipcMain.handle("a2a:config:get", () => ({
  agents: [{ agentId: "fixture-agent", enabled: true }],
}));
ipcMain.handle("a2a:server:status", () => ({
  phase: running ? "running" : "stopped",
}));
ipcMain.handle("a2a:server:retry", () => {
  running = true;
  retries++;
  return { phase: "running" };
});
ipcMain.handle("a2a:token:reveal", () => ({ token: "runtime-fixture-only" }));
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1100,
    height: 850,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.loadFile(path.join(__dirname, "aimana-runtime.html"));
});
app.on("window-all-closed", () => app.quit());
