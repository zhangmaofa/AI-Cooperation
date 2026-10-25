import { DesktopService } from "./service.mjs";
const pending = new Map();
let secretId = 0;
const service = new DesktopService({
  root: process.env.AICO_DATA_DIR,
  codexCommand: process.env.AICO_CODEX_COMMAND || "codex.exe",
  notify: (snapshot) => process.send?.({ type: "snapshot", snapshot }),
  secret: (ref) =>
    new Promise((resolve, reject) => {
      if (!ref) return resolve("");
      const id = ++secretId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("凭据读取超时"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      process.send?.({ type: "secret", id, ref });
    }),
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
      process.send?.({
        type: "response",
        id: message.id,
        result: await service.handle(message.method, message.data),
      });
    } catch (error) {
      process.send?.({
        type: "response",
        id: message.id,
        error: error.message,
      });
    }
  }
});
let ticking = false;
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await service.tick();
  } finally {
    ticking = false;
  }
}, 2500);
process.on("disconnect", () => {
  clearInterval(timer);
  service.close();
  process.exit(0);
});
process.send?.({ type: "ready", snapshot: service.snapshot() });
