const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  safeStorage,
  dialog,
  shell,
  Notification,
  nativeTheme,
} = require("electron");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { installConnector } = require("./connector.cjs");
const { notices } = require("./notifications.cjs");
const {
  conversationTarget,
  taskTarget,
  automaticTargets,
} = require("./native-links.cjs");

let window,
  worker,
  tray,
  quitting = false,
  latest;
let previewMode;
function applyNativeTheme(mode) {
  if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
  if (window && !window.isDestroyed())
    window.setBackgroundColor(
      nativeTheme.shouldUseDarkColors ? "#141b23" : "#f6f8fa",
    );
}
let sequence = 0;
const requests = new Map();
const notifications = new Set();
const openedDesktopTargets = new Set();
const root = path.join(__dirname, "..");
const dataDir =
  process.env.AICO_DATA_DIR ||
  path.join(app.getPath("appData"), "..", "Local", "AI-Cooperation");
const vaultPath = path.join(dataDir, "credentials.json");
let vault = {};
function saveVault() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = vaultPath + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(vault), { mode: 0o600 });
  fs.renameSync(temp, vaultPath);
}
function findCommand(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const full = path.join(dir.replace(/^"|"$/g, ""), name);
    if (fs.existsSync(full)) return full;
  }
  return name;
}
function request(method, data) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error("后台操作超时，请查看任务状态，勿重复发送"));
    }, 220000);
    requests.set(id, { resolve, reject, timer });
    worker.send({ type: "request", id, method, data });
  });
}
function sendSnapshot() {
  if (latest && window && !window.isDestroyed())
    window.webContents.send("cooperation:snapshot", latest);
}
function showWindow() {
  if (!window) createWindow();
  window.show();
  window.focus();
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 740,
    title: "AI-Cooperation",
    icon: path.join(__dirname, "assets", "app.ico"),
    backgroundColor: "#f6f7f9",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (!quitting && !process.env.AICO_TEST) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.on("did-finish-load", sendSnapshot);
  window.loadFile(path.join(root, "dist", "ui", "index.html"));
}

if (process.env.AICO_TEST)
  app.setPath("userData", path.join(dataDir, "electron-profile"));
if (!process.env.AICO_TEST && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app
    .whenReady()
    .then(() => {
      fs.mkdirSync(dataDir, { recursive: true });
      try {
        vault = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT")
          dialog.showErrorBox(
            "凭据文件无法读取",
            "已有凭据文件损坏，请保留该文件并重新配置连接。",
          );
      }
      const node = app.isPackaged
        ? path.join(process.resourcesPath, "runtime", "node.exe")
        : process.env.AICO_NODE_EXEC ||
          process.env.npm_node_execpath ||
          findCommand("node.exe");
      worker = fork(path.join(root, "backend", "worker.mjs"), [], {
        execPath: node,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          AICO_DATA_DIR: dataDir,
          AICO_CODEX_COMMAND: findCommand("codex.exe"),
        },
      });
      worker.stdout.on("data", () => {});
      worker.stderr.on("data", () => {});
      worker.on("message", (message) => {
        if (message.type === "warning")
          window?.webContents.send("cooperation:warning", message.message);
        if (message.type === "save-secret") {
          try {
            if (
              !safeStorage.isEncryptionAvailable() ||
              typeof message.value !== "string" ||
              message.value.length > 16000
            )
              throw new Error("安全存储不可用");
            const ref = crypto.randomUUID();
            vault[ref] = safeStorage
              .encryptString(message.value)
              .toString("base64");
            saveVault();
            worker.send({ type: "secret-result", id: message.id, value: ref });
          } catch {
            worker.send({ type: "secret-result", id: message.id, error: true });
          }
        }
        if (message.type === "ready" || message.type === "snapshot") {
          for (const target of automaticTargets(latest, message.snapshot)) {
            if (openedDesktopTargets.has(target.key)) continue;
            openedDesktopTargets.add(target.key);
            if (openedDesktopTargets.size > 512)
              openedDesktopTargets.delete(
                openedDesktopTargets.values().next().value,
              );
            shell
              .openExternal(target.url)
              .catch(() =>
                window?.webContents.send(
                  "cooperation:warning",
                  "未能自动打开 Codex 桌面，请检查 codex:// 协议是否已注册，或手动点击打开原对话。",
                ),
              );
          }
          const mode = message.snapshot.preferences?.mode || "system";
          if (previewMode === mode) previewMode = undefined;
          applyNativeTheme(previewMode || mode);
          if (!process.env.AICO_TEST && Notification.isSupported()) {
            for (const item of notices(latest, message.snapshot)) {
              try {
                const notice = new Notification({
                  title: item.title,
                  body: item.body,
                  icon: path.join(__dirname, "assets", "app.ico"),
                  silent: true,
                });
                notifications.add(notice);
                notice.once("close", () => notifications.delete(notice));
                notice.once("click", () => {
                  showWindow();
                  window?.webContents.send("cooperation:navigate", item);
                  notifications.delete(notice);
                });
                notice.show();
              } catch {}
            }
          }
          latest = message.snapshot;
          sendSnapshot();
        }
        if (message.type === "response") {
          const pending = requests.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          requests.delete(message.id);
          message.error
            ? pending.reject(new Error(message.error))
            : pending.resolve(message.result);
        }
        if (message.type === "secret") {
          try {
            worker.send({
              type: "secret-result",
              id: message.id,
              value: vault[message.ref]
                ? safeStorage.decryptString(
                    Buffer.from(vault[message.ref], "base64"),
                  )
                : "",
            });
          } catch {
            worker.send({ type: "secret-result", id: message.id, error: true });
          }
        }
      });
      worker.on("error", (error) =>
        dialog.showErrorBox(
          "协调后台启动失败",
          `请检查 Node 运行环境：${error.message}`,
        ),
      );
      worker.on("exit", () => {
        for (const pending of requests.values()) {
          clearTimeout(pending.timer);
          pending.reject(
            new Error("协调后台已停止，请重启应用后核对远端任务状态"),
          );
        }
        requests.clear();
        if (!quitting) window?.webContents.send("cooperation:offline");
      });
      const allowed = new Set([
        "snapshot",
        "desktop.open-conversation",
        "desktop.open-task",
        "project.save",
        "conversation.defaults",
        "conversation.create",
        "conversation.read",
        "conversation.send",
        "conversation.start",
        "conversation.recover",
        "conversation.cancel",
        "conversation.open",
        "connection.save",
        "connection.test",
        "connection.profile",
        "task.analyze",
        "task.create",
        "task.action",
        "scheduler.save",
        "preferences.save",
        "preferences.preview",
        "workflow.analyze",
        "workflow.create",
        "workflow.preflight",
        "workflow.pause",
        "workflow.start",
        "workflow.review",
        "pairing.start",
        "pairing.status",
        "connector.install",
        "integration.info",
      ]);
      ipcMain.handle(
        "cooperation:request",
        async (event, method, data = {}) => {
          if (event.sender !== window?.webContents || !allowed.has(method))
            throw new Error("不支持的操作");
          if (
            method === "desktop.open-conversation" ||
            method === "desktop.open-task"
          ) {
            const target =
              method === "desktop.open-conversation"
                ? conversationTarget(latest, data.id)
                : taskTarget(latest, data.id);
            try {
              await shell.openExternal(target.url);
            } catch {
              throw new Error(
                "无法打开 Codex 桌面。请确认 Codex 已安装并注册 codex:// 协议；原会话与结果仍保留。",
              );
            }
            return { launched: true, threadId: target.threadId };
          }
          if (method === "preferences.preview") {
            if (!["system", "light", "dark"].includes(data.mode))
              throw new Error("无效的明暗模式");
            previewMode =
              data.mode === latest?.preferences?.mode ? undefined : data.mode;
            applyNativeTheme(data.mode);
            return true;
          }
          if (method === "integration.info")
            return {
              mcp: {
                command: node,
                args: [path.join(root, "mcp.mjs"), "--desktop"],
                env: { AICO_DATA_DIR: dataDir },
              },
            };
          if (method === "connector.install") {
            const runtime = path.join(
              process.env.LOCALAPPDATA || app.getPath("userData"),
              ".aimana-plusplus",
            );
            return installConnector(root, runtime);
          }
          if (method === "connection.save") {
            if (data.token && typeof data.token !== "string")
              throw new Error("凭据格式错误");
            if (data.token) {
              if (data.token.length > 16000)
                throw new Error("凭据长度超出范围");
              if (!safeStorage.isEncryptionAvailable())
                throw new Error("系统安全存储不可用，无法保存凭据");
              const ref = crypto.randomUUID();
              vault[ref] = safeStorage
                .encryptString(data.token)
                .toString("base64");
              saveVault();
              data = { ...data, tokenRef: ref };
            }
            const { token, ...clean } = data;
            data = clean;
          }
          return request(method, data);
        },
      );
      ipcMain.handle("cooperation:pick-directory", async () => {
        const value = await dialog.showOpenDialog(window, {
          properties: ["openDirectory"],
        });
        return value.canceled ? null : value.filePaths[0];
      });
      ipcMain.handle("cooperation:open-data", () => shell.openPath(dataDir));
      ipcMain.handle("cooperation:quit", () => {
        quitting = true;
        app.quit();
      });
      createWindow();
      // Multi-resolution ICO lets Windows select a sharp image at the tray DPI.
      tray = new Tray(path.join(__dirname, "assets", "app.ico"));
      tray.setToolTip("AI-Cooperation · 协调器");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 AI-Cooperation", click: showWindow },
          { type: "separator" },
          {
            label: "完全退出",
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ]),
      );
      tray.on("double-click", showWindow);
    })
    .catch((error) => {
      dialog.showErrorBox("启动失败", error.message);
      quitting = true;
      app.quit();
    });
}
app.on("before-quit", () => {
  quitting = true;
  if (worker?.connected) worker.disconnect();
});
app.on("window-all-closed", () => {
  if (process.env.AICO_TEST || quitting) app.quit();
});
