const { ipcMain, safeStorage } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createServer } = require("node:http");
const BUILD = "0.5.0";
const terminal = new Set(["completed", "input-required", "failed", "canceled"]);
function result(run) {
  return {
    kind: "task",
    id: run.id,
    contextId: run.contextId,
    status: {
      state: run.state,
      message: {
        parts: [{ kind: "text", text: run.text || "AIMana Cowork 正在执行" }],
      },
    },
    metadata: {
      agentId: run.profile.agentId,
      requestedModel: run.profile.model,
      actualModel: run.actualModel,
      conversationId: run.conversationId,
      turnId: run.turnId,
    },
  };
}
exports.start = function (api) {
  const prefix = `aimanapp:t:${api.manifest.id}:cowork`;
  const file = path.join(api.fs.dataDir, "cowork-state.json");
  fs.mkdirSync(api.fs.dataDir, { recursive: true });
  const state = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { runs: {}, contexts: {} };
  function save() {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  for (const run of Object.values(state.runs))
    if (!terminal.has(run.state)) {
      run.state = "unknown";
      run.text = "插件曾重载或退出，原回合待核对；不会自动重发。";
    }
  save();
  let renderer, token, endpoint, server, listening;
  const pending = new Map(),
    channels = [];
  const handle = (name, action) => {
    const channel = `${prefix}:${name}`;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, action);
    channels.push(channel);
  };
  function dispatch(method, data) {
    if (!renderer || renderer.isDestroyed())
      throw new Error("AIMana 窗口未就绪");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Cowork 接口超时，请核对原会话"));
      }, 35000);
      pending.set(id, { resolve, reject, timer, sender: renderer.id });
      renderer.send(`${prefix}:job`, { id, method, data });
    });
  }
  handle("hello", (event) => {
    if (!event.sender.getURL().startsWith("file://"))
      throw new Error("仅允许原生本地窗口");
    if (!renderer || renderer.isDestroyed() || renderer.id === event.sender.id)
      renderer = event.sender;
    return {
      build: BUILD,
      active: renderer.id === event.sender.id,
      runs: Object.values(state.runs).filter((r) => !terminal.has(r.state)),
    };
  });
  handle("reply", (event, payload) => {
    const job = pending.get(payload.id);
    if (!job || job.sender !== event.sender.id) return false;
    pending.delete(payload.id);
    clearTimeout(job.timer);
    payload.error
      ? job.reject(new Error("原生 Cowork 接口未确认操作"))
      : job.resolve(payload.result);
    return true;
  });
  handle("run", (event, { id, patch }) => {
    if (renderer?.id !== event.sender.id || !Object.hasOwn(state.runs, id))
      throw new Error("会话不属于本插件");
    const run = state.runs[id];
    for (const key of [
      "conversationId",
      "contextId",
      "state",
      "text",
      "baseline",
      "actualModel",
      "ended",
      "cancelled",
      "backgroundPending",
    ])
      if (patch[key] !== undefined) run[key] = patch[key];
    if (run.conversationId)
      state.contexts[run.contextId] = {
        conversationId: run.conversationId,
        profile: run.profile,
      };
    save();
    return true;
  });
  async function rpc(method, data) {
    if (method === "inspect") return dispatch("inspect", {});
    if (method === "send") {
      if (
        !/^[\w-]{1,100}$/.test(data.messageId || "") ||
        typeof data.text !== "string" ||
        data.text.length > 200000
      )
        throw new Error("任务消息不合法");
      const id = `cowork-${data.messageId}`;
      const requestHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify([
            data.text,
            data.contextId,
            data.taskId,
            data.profile,
          ]),
        )
        .digest("hex");
      if (Object.hasOwn(state.runs, id)) {
        if (state.runs[id].requestHash !== requestHash)
          throw new Error("消息标识与原任务不一致");
        return result(state.runs[id]);
      }
      const profile = data.profile;
      if (
        !profile?.agentId ||
        !profile.model ||
        !profile.cwd ||
        profile.permissionMode !== "ask"
      )
        throw new Error("请选择 Agent、模型和目录");
      const context =
        data.contextId &&
        Object.hasOwn(state.contexts, data.contextId) &&
        state.contexts[data.contextId];
      if (
        data.contextId &&
        (!context ||
          JSON.stringify(context.profile) !== JSON.stringify(profile))
      )
        throw new Error("原会话配置不匹配");
      if (
        data.contextId &&
        Object.values(state.runs).some(
          (r) => r.contextId === data.contextId && !terminal.has(r.state),
        )
      )
        throw new Error("原会话还有待核对回合");
      if (
        data.taskId &&
        (state.runs[data.taskId]?.contextId !== data.contextId ||
          state.runs[data.taskId]?.state !== "input-required")
      )
        throw new Error("答疑不属于原会话");
      const run = {
        id,
        requestHash,
        profile,
        contextId: data.contextId || `pending-${id}`,
        conversationId: context?.conversationId,
        turnId: crypto.randomUUID(),
        state: "unknown",
        text: "发送意图已记录，原生回合尚待确认",
        createdAt: new Date().toISOString(),
      };
      state.runs[id] = run;
      save();
      await dispatch("send", { run, text: data.text });
      return result(state.runs[id]);
    }
    if (!Object.hasOwn(state.runs, data.id || ""))
      throw new Error("原执行记录不存在");
    const run = state.runs[data.id];
    if (method === "open") {
      await dispatch("open", { run });
      return { opened: true };
    }
    if (method === "poll") {
      if (!terminal.has(run.state) && run.conversationId)
        await dispatch("poll", { run });
      return result(state.runs[data.id]);
    }
    if (method === "cancel") {
      await dispatch("cancel", { run });
      return { requested: true };
    }
    throw new Error("不支持的 Cowork 操作");
  }
  async function ensureServer() {
    if (listening) return listening;
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用");
    token = state.credential
      ? safeStorage.decryptString(Buffer.from(state.credential, "base64"))
      : crypto.randomBytes(32).toString("hex");
    state.credential = safeStorage.encryptString(token).toString("base64");
    save();
    server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      const send = (status, body) => {
        response.statusCode = status;
        response.end(JSON.stringify(body));
      };
      const actual = Buffer.from(request.headers.authorization || ""),
        expected = Buffer.from(`Bearer ${token}`);
      if (
        request.method !== "POST" ||
        request.url !== "/cowork" ||
        request.headers.origin ||
        request.headers.host !== new URL(endpoint).host ||
        actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)
      )
        return send(403, { error: "Unauthorized" });
      let body;
      try {
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 256000)
            return send(413, { error: "Request too large" });
        }
        body = JSON.parse(raw);
        if (typeof body.id !== "string" || body.id.length > 100)
          throw new Error("请求不合法");
        send(200, {
          id: body.id,
          result: await rpc(body.method, body.data || {}),
        });
      } catch {
        send(200, {
          id: body?.id,
          error:
            "Cowork 操作未确认，请在 AIMana 检查原会话、模型或权限。系统不会自动重发。",
        });
      }
    });
    listening = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(state.port || 0, "127.0.0.1", () => {
        state.port = server.address().port;
        endpoint = `http://127.0.0.1:${state.port}/cowork`;
        save();
        resolve(endpoint);
      });
    });
    return listening;
  }
  handle("pair", async (event, { code }) => {
    if (renderer?.id !== event.sender.id)
      throw new Error("请在 AIMana 主窗口配对");
    const match = /^(\d{1,5})\.([a-f0-9]{36})$/.exec(code || "");
    if (!match || +match[1] < 1 || +match[1] > 65535)
      return { ok: false, message: "配对码格式不正确" };
    try {
      await ensureServer();
      const response = await fetch(`http://127.0.0.1:${match[1]}/pair`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, transport: "cowork", endpoint, token }),
      });
      const value = await response.json();
      return response.ok && value.ok
        ? { ok: true }
        : {
            ok: false,
            message: value.error || "配对失败，请更新协调器并生成新码",
          };
    } catch {
      return {
        ok: false,
        message: "无法完成配对，请保持协调器运行并确认使用 0.4.0 或更新版本",
      };
    }
  });
  if (state.credential)
    ensureServer().catch(() => api.log.warn("Cowork 本机桥未启动，请重新配对"));
  api.log.info(`connector ${BUILD} main loaded Cowork`);
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error("连接插件已停止"));
    }
    pending.clear();
    server?.closeAllConnections();
    server?.close();
  };
};
