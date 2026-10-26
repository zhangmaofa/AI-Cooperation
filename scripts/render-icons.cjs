const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", process.env.AICO_ICON_PROFILE);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.loadURL("data:text/html,<html><title>Icon renderer</title></html>");
});
app.on("window-all-closed", () => app.quit());
