import { DesktopService } from "./service.mjs";
import { startBridge } from "./bridge.mjs";
const pending = new Map();
const send = (message) => {
  if (process.connected) process.send(message);
};
let secretId = 0;
const service = new DesktopService({
  root: process.env.AICO_DATA_DIR,
  codexCommand: process.env.AICO_CODEX_COMMAND || "codex.exe",
  notify: (snapshot) => send({ type: "snapshot", snapshot }),
  secret: (ref) =>
    new Promise((resolve, reject) => {
      if (!ref) return resolve("");
      const id = ++secretId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("凭据读取超时"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      send({ type: "secret", id, ref });
    }),
});
function saveSecret(value) {
  return new Promise((resolve, reject) => {
    const id = ++secretId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("加密保存超时"));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    send({ type: "save-secret", id, value });
  });
}
const bridge = await startBridge(service, {
  root: process.env.AICO_DATA_DIR,
  saveSecret,
});
process.on("message", async (message) => {
  if (message.type === "secret-result") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error
      ? request.reject(new Error("无法读取本机保存的凭据，请重新保存连接"))
      : request.resolve(message.value);
    return;
  }
  if (message.type === "request") {
    try {
      send({
        type: "response",
        id: message.id,
        result:
          message.method === "pairing.start"
            ? bridge.startPairing()
            : message.method === "pairing.status"
              ? bridge.pairingStatus()
              : await service.handle(message.method, message.data),
      });
    } catch (error) {
      send({
        type: "response",
        id: message.id,
        error: error.message,
      });
    }
  }
});
let ticking = false;
let warned = false;
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await service.tick();
    warned = false;
  } catch {
    if (!warned)
      send({
        type: "warning",
        message: "后台调度暂时失败，任务和原会话已保留，请检查协作状态。",
      });
    warned = true;
  } finally {
    ticking = false;
  }
}, 2500);
process.on("disconnect", () => {
  clearInterval(timer);
  service.close();
  bridge.close().finally(() => process.exit(0));
});
send({ type: "ready", snapshot: service.snapshot() });
