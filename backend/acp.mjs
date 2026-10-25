import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

// ACP v1 transport. No shell, delegated filesystem, terminal, authentication, or automatic permissions.
export class AcpClient {
  constructor(connection, { spawnImpl = spawn } = {}) {
    this.connection = connection;
    this.spawn = spawnImpl;
    this.pending = new Map();
    this.opened = new Set();
    this.active = new Map();
    this.nextId = 0;
  }
  send(message) {
    this.child?.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }
  request(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} 超时，请核对原会话`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.child = this.spawn(
        this.connection.command,
        this.connection.args || [],
        {
          cwd: this.connection.cwd || undefined,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const child = this.child;
      this.child.stdin.on("error", () => {});
      this.child.stderr.on("data", () => {});
      this.child.on("error", () => {
        if (this.child === child)
          this.fail(new Error("无法启动 ACP 程序，请检查路径与参数"));
      });
      this.child.on("exit", () => {
        if (this.child === child) {
          this.opened.clear();
          this.fail(new Error("ACP 进程退出，未确认的任务需要核对"));
        }
      });
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on("line", (line) => {
        try {
          this.message(JSON.parse(line));
        } catch {}
      });
      this.info = await this.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "ai-cooperation", version: "0.3.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      if (this.info.protocolVersion !== 1)
        throw new Error("该 ACP 版本尚未适配，需要 ACP v1");
      return this.info;
    })();
    try {
      return await this.starting;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  message(message) {
    if (message.method && message.id !== undefined) {
      if (message.method === "session/request_permission") {
        const turn = this.active.get(message.params?.sessionId);
        if (turn) turn.needsUser = true;
        this.send({
          id: message.id,
          result: { outcome: { outcome: "cancelled" } },
        });
      } else
        this.send({
          id: message.id,
          error: { code: -32601, message: "Client capability unavailable" },
        });
      return;
    }
    if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      message.error
        ? request.reject(
            new Error(
              `ACP 请求失败：${String(message.error.message).slice(0, 400)}`,
            ),
          )
        : request.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      const turn = this.active.get(message.params?.sessionId),
        update = message.params?.update;
      if (
        turn &&
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      )
        turn.text = (turn.text + update.content.text).slice(-100000);
    }
  }
  async inspect() {
    const info = await this.start();
    return {
      message: `ACP v1 已连接：${info.agentInfo?.title || info.agentInfo?.name || "Agent"}。未发起模型推理；工作区权限由目标软件管理。`,
      capabilities: {
        sameSession: true,
        recover: false,
        cancel: true,
        loadSession: info.agentCapabilities?.loadSession === true,
        sandboxEnforced: false,
      },
    };
  }
  async openThread(id) {
    await this.start();
    const params = { cwd: this.connection.cwd, mcpServers: [] };
    let session;
    if (id) {
      if (this.opened.has(id)) return id;
      if (!this.info.agentCapabilities?.loadSession)
        throw new Error("此 ACP 软件无法恢复原会话，不能另开会话冒充返工");
      session = await this.request("session/load", {
        ...params,
        sessionId: id,
      });
    } else {
      session = await this.request("session/new", params);
      id = session.sessionId;
    }
    if (!id) throw new Error("ACP 未返回会话 ID");
    if (this.connection.model) {
      const models = session.models?.availableModels || [];
      if (!models.some((model) => model.modelId === this.connection.model))
        throw new Error("ACP 会话未声明所选模型，不能自动替换");
      await this.request("session/set_model", {
        sessionId: id,
        modelId: this.connection.model,
      });
    }
    this.opened.add(id);
    return id;
  }
  run(...args) {
    const result = (this.queue || Promise.resolve()).then(() =>
      this.runTurn(...args),
    );
    this.queue = result.catch(() => {});
    return result;
  }
  async runTurn(
    prompt,
    id,
    { threadPrepared, onStarted, timeoutMs = 900000 } = {},
  ) {
    id = await this.openThread(id);
    const turn = { text: "", needsUser: false };
    this.active.set(id, turn);
    onStarted?.({ threadId: id, turnId: `acp-${randomUUID()}` });
    try {
      const result = await this.request(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text: prompt }] },
        timeoutMs,
      );
      if (
        !turn.needsUser &&
        !["end_turn", "cancelled"].includes(result.stopReason)
      )
        throw new Error(`ACP 回合未正常结束：${result.stopReason}`);
      return {
        text: turn.text,
        threadId: id,
        needsUser: turn.needsUser,
        cancelled: result.stopReason === "cancelled",
      };
    } catch (error) {
      this.send({ method: "session/cancel", params: { sessionId: id } });
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
  async interrupt(id) {
    this.send({ method: "session/cancel", params: { sessionId: id } });
  }
  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.starting = null;
  }
  close() {
    this.fail(new Error("ACP 连接关闭"));
    this.lines?.close();
    this.child?.kill();
    this.child = null;
    this.opened.clear();
  }
}
