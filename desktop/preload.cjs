const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cooperation", {
  request: (method, data) =>
    ipcRenderer.invoke("cooperation:request", method, data),
  subscribe: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("cooperation:snapshot", handler);
    return () => ipcRenderer.removeListener("cooperation:snapshot", handler);
  },
  onOffline: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("cooperation:offline", handler);
    return () => ipcRenderer.removeListener("cooperation:offline", handler);
  },
  onNavigate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("cooperation:navigate", handler);
    return () => ipcRenderer.removeListener("cooperation:navigate", handler);
  },
  onWarning: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("cooperation:warning", handler);
    return () => ipcRenderer.removeListener("cooperation:warning", handler);
  },
  pickDirectory: () => ipcRenderer.invoke("cooperation:pick-directory"),
  openData: () => ipcRenderer.invoke("cooperation:open-data"),
  quit: () => ipcRenderer.invoke("cooperation:quit"),
});
