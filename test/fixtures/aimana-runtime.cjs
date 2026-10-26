const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
app.setPath(
  "userData",
  path.join(process.env.AIMANAPP_USER_ROOT, "electron-profile"),
);
require(path.join(process.env.AIMANAPP_RUNTIME, "main.cjs"));
const fs = require("node:fs");
const workspace = process.env.AIMANAPP_WORKSPACE;
let sessions = [],
  starts = 0,
  window;
let opened;
ipcMain.handle("cowork:floating-window:open", (_event, { conversationId }) => {
  if (!get(conversationId)) throw new Error("missing session");
  opened = conversationId;
  return { opened: true };
});
const agents = [
  {
    id: "writer",
    name: "文档 Agent",
    engine: "mana",
    model: "model-small",
    skillIds: ["writing"],
  },
  {
    id: "coder",
    name: "编码 Agent",
    engine: "claude",
    model: "model-code",
    skillIds: ["coding"],
  },
];
const get = (id) => sessions.find((s) => s.id === id);
const emit = (session, extra = {}) =>
  window.webContents.send("agent-runtime:conversation:event", {
    scope: { business: "cowork", accountKey: "fixture-only" },
    execution: { conversationId: session.id },
    event: { type: "turn_end", turnId: session.turnId, ...extra },
  });
ipcMain.handle("cowork:agents:list", () => agents);
ipcMain.handle("cowork:projects:list", () => [
  { name: "isolated fixture", cwd: workspace },
]);
ipcMain.handle("cowork:agent:engineModels", (_event, { engine }) =>
  engine === "mana" ? ["model-small", "model-large"] : ["model-code"],
);
ipcMain.handle("cowork:sessions:create", (_event, input) => {
  if (
    input.ownerSurface !== "cowork" ||
    input.permissionMode !== "ask" ||
    input.projectCwd !== workspace ||
    !agents.some((a) => a.id === input.agentId)
  )
    throw new Error("invalid fixture binding");
  const session = {
    ...input,
    id: sessions.length + 1,
    isRunning: false,
    messages: [],
  };
  sessions.push(session);
  return { ...session, messages: undefined };
});
ipcMain.handle("cowork:sessions:list", (_event, { conversationId } = {}) =>
  sessions
    .filter((s) => !conversationId || s.id === conversationId)
    .map(({ messages, ...s }) => s),
);
ipcMain.handle("cowork:sessions:loadMessages", (_event, { id }) => ({
  messages: get(id).messages,
}));
const start = (_event, input) => {
  const s = get(input.conversationId);
  if (
    s.isRunning ||
    s.model !== input.modelLabel ||
    s.agentId !== input.agentId ||
    input.permissionMode !== "ask"
  )
    throw new Error("fixture dispatch mismatch");
  s.isRunning = true;
  s.lastPrompt = input.prompt;
  s.turnId = input.turnId;
  s.sdkSessionId = `sdk-${s.id}`;
  starts++;
};
ipcMain.handle("cowork:session:start", start);
ipcMain.handle("cowork:session:continue", start);
ipcMain.handle("cowork:session:abort", (_event, { conversationId, turnId }) => {
  const s = get(conversationId);
  if (s.turnId !== turnId) throw new Error("wrong turn");
  s.isRunning = false;
  emit(s, { cancelled: true });
});
global.fixture = {
  snapshot: () => ({ starts, sessions, opened }),
  finish(id, report, extra = {}) {
    const s = get(id);
    s.isRunning = false;
    s.messages.push({
      id: `m-${starts}-${s.messages.length}`,
      role: "assistant",
      turnId: s.turnId,
      status: "done",
      blocks: [{ kind: "text", text: JSON.stringify(report) }],
    });
    if (report.summary)
      fs.writeFileSync(path.join(workspace, "result.txt"), report.summary);
    emit(s, extra);
  },
  stale(id) {
    emit(get(id), { turnId: "old-unrelated-turn" });
  },
  permission(id, enabled) {
    get(id).pendingConfirmation = enabled ? { id: "confirm-fixture" } : null;
  },
  switchModel(id, model) {
    get(id).model = model;
  },
};
app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 1100,
    height: 850,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.loadFile(path.join(__dirname, "aimana-runtime.html"));
});
app.on("window-all-closed", () => app.quit());
