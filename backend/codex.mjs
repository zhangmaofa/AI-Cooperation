import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { finalText } from "./progress.mjs";

export class CodexClient {
  constructor(connection, { spawnImpl = spawn, role = "coordinator" } = {}) {
    this.connection = connection;
    this.pending = new Map();
    this.turns = new Map();
    this.nextId = 1;
    this.spawn = spawnImpl;
    this.role = role;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.child = this.spawn(
        this.connection.command || "codex.exe",
        [...(this.connection.args || []), "app-server", "--listen", "stdio://"],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const child = this.child;
      this.child.stdin.on("error", () => {});
      this.child.stderr.on("data", () => {}); // Do not forward model/runtime logs or credentials into UI.
      this.child.on("error", (error) => {
        if (this.child === child)
          this.fail(
            new Error(
              `无法启动 Codex：${error.code || "进程错误"}，请检查程序路径`,
            ),
          );
      });
      this.child.on("exit", () => {
        if (this.child === child)
          this.fail(new Error("Codex 连接已关闭，请重新测试连接"));
      });
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on("line", (line) => {
        try {
          this.message(JSON.parse(line));
        } catch {}
      });
      await this.request("initialize", {
        clientInfo: {
          name: "ai_cooperation",
          title: "AI-Cooperation",
          version: "0.7.1",
        },
      });
      this.send({ method: "initialized", params: {} });
    })();
    try {
      await this.starting;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  send(message) {
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 响应超时`));
      }, timeout);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        threadId: params?.threadId,
      });
      this.send({ id, method, params });
    });
  }
  message(message) {
    if (message.method && message.id !== undefined) {
      this.turns.get(message.params?.threadId)?.onProgress?.({
        type: "approval",
        message: "Codex 请求交互权限，协调器未自动批准。",
      });
      // Both profiles decline interactive escalation; workers can write only in the selected workspace sandbox.
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message:
            "Interactive escalation is not available in this connection; stay within the configured sandbox",
        },
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (pending.method === "turn/start" && message.result?.turn?.id) {
        const turn = this.turns.get(pending.threadId);
        if (turn) turn.turnId = message.result.turn.id;
      }
      message.error
        ? pending.reject(
            new Error(
              `Codex 请求失败：${String(message.error.message).slice(0, 400)}`,
            ),
          )
        : pending.resolve(message.result);
      return;
    }
    const params = message.params || {};
    const turn = this.turns.get(params.threadId);
    if (!turn) return;
    const eventTurnId = params.turnId || params.turn?.id;
    if (turn.turnId && eventTurnId && eventTurnId !== turn.turnId) return;
    if (message.method === "thread/tokenUsage/updated")
      turn.usage = params.tokenUsage?.last;
    if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item = params.item;
      if (item?.type === "agentMessage") {
        const id = item.id || "legacy";
        turn.items.set(id, { ...turn.items.get(id), ...item });
        turn.onProgress?.({
          type: "message",
          phase: item.phase,
          text: item.text || "",
          itemId: id,
        });
      } else
        turn.onProgress?.({
          type:
            message.method === "item/started"
              ? "item-started"
              : "item-completed",
          itemType: item?.type,
        });
    }
    if (message.method === "item/agentMessage/delta") {
      const id = params.itemId || "legacy";
      const old = turn.items.get(id) || {
        type: "agentMessage",
        text: "",
        phase: params.phase,
      };
      const item = { ...old, text: (old.text || "") + (params.delta || "") };
      turn.items.set(id, item);
      turn.onProgress?.({
        type: "message",
        phase: item.phase,
        text: item.text,
        itemId: id,
      });
    }
    if (message.method === "error") {
      turn.lastError = params.error?.message;
      turn.onProgress?.({ type: "error", message: params.error?.message });
    }
    // These streams are activity signals only. Never forward reasoning or raw tool output.
    if (message.method?.startsWith("item/reasoning/"))
      turn.onProgress?.({ type: "item-activity", itemType: "reasoning" });
    if (message.method === "item/commandExecution/outputDelta")
      turn.onProgress?.({
        type: "item-activity",
        itemType: "commandExecution",
      });
    if (
      message.method === "item/completed" &&
      params.item?.type === "agentMessage"
    )
      turn.text = finalText([...turn.items.values()]);
    if (message.method === "turn/completed") {
      this.turns.delete(params.threadId);
      clearTimeout(turn.timer);
      if (params.turn?.status === "interrupted") {
        turn.resolve({
          cancelled: true,
          threadId: params.threadId,
          text: finalText([...turn.items.values()]),
        });
        return;
      }
      const error = new Error(
        `Codex 回合未完成：${params.turn?.status || "unknown"}${params.turn?.error?.message || turn.lastError ? "；" + (params.turn?.error?.message || turn.lastError) : ""}`,
      );
      if (params.turn?.status === "failed") error.terminalState = "failed";
      params.turn?.status === "completed"
        ? turn.resolve({
            text: finalText([...turn.items.values()]) || turn.text,
            threadId: params.threadId,
            usage: turn.usage,
          })
        : turn.reject(error);
    }
  }
  async inspect() {
    await this.start();
    const models = await this.request("model/list", { limit: 50 });
    return {
      message: "Codex app-server 已连接；模型列表读取成功（尚未发起模型推理）",
      models: (models.data || []).map((m) => ({
        id: m.model || m.id,
        name: m.displayName || m.id,
      })),
    };
  }
  async openThread(threadId, connection = this.connection) {
    await this.start();
    const params = {
      sandbox: this.role === "executor" ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      ...(connection.model ? { model: connection.model } : {}),
      ...(connection.cwd ? { cwd: connection.cwd } : {}),
    };
    if (threadId)
      await this.request("thread/resume", {
        ...params,
        threadId,
        excludeTurns: true,
      });
    else threadId = (await this.request("thread/start", params)).thread.id;
    return threadId;
  }
  run(prompt, threadId, options = {}) {
    // One controller never starts competing decisions, even across child tasks.
    const profile = { ...this.connection };
    const result = (this.queue || Promise.resolve()).then(() =>
      this.runTurn(prompt, threadId, { ...options, profile }),
    );
    this.queue = result.catch(() => {});
    return result;
  }
  async runTurn(
    prompt,
    threadId,
    {
      onStarted,
      onProgress,
      threadPrepared = false,
      profile = this.connection,
      timeoutMs = this.role === "executor" ? 900000 : 180000,
    } = {},
  ) {
    if (threadPrepared) {
      await this.start();
      if (!threadId) throw new Error("缺少已打开的 Codex 会话");
    } else threadId = await this.openThread(threadId, profile);
    if (this.turns.has(threadId))
      throw new Error("该 Codex 会话正在工作，请等待本回合结束");
    const result = new Promise((resolve, reject) => {
      const turn = {
        text: "",
        items: new Map(),
        resolve,
        reject,
        timer: null,
        turnId: null,
        onProgress,
      };
      turn.timer = setTimeout(() => {
        this.turns.delete(threadId);
        if (turn.turnId)
          this.request("turn/interrupt", {
            threadId,
            turnId: turn.turnId,
          }).catch(() => {});
        reject(new Error("Codex 回合超时，已请求停止；请核对会话状态后再重试"));
      }, timeoutMs);
      this.turns.set(threadId, turn);
    });
    // Attach a rejection handler immediately; turn/start may fail before callers await the result.
    result.catch(() => {});
    try {
      const reply = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
      });
      if (this.turns.has(threadId))
        this.turns.get(threadId).turnId = reply.turn.id;
      onStarted?.({ threadId, turnId: reply.turn.id });
      onProgress?.({ type: "started", turnId: reply.turn.id });
    } catch (error) {
      const turn = this.turns.get(threadId);
      if (turn) {
        clearTimeout(turn.timer);
        this.turns.delete(threadId);
        turn.reject(error);
      }
      throw error;
    }
    return result;
  }
  async readTurn(threadId, turnId) {
    await this.start();
    const result = await this.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const turn = result.thread?.turns?.find((t) => t.id === turnId);
    if (!turn) throw new Error("原执行轮次暂不可读取，保留待核对状态");
    const reply = {
      status: turn.status,
      text: finalText(turn.items || []),
      publicMessage: (turn.items || [])
        .filter((i) => i.type === "agentMessage" && i.phase === "commentary")
        .at(-1)?.text,
      error: turn.error?.message,
    };
    const live = this.turns.get(threadId);
    if (
      live &&
      live.turnId === turnId &&
      ["completed", "interrupted", "failed"].includes(turn.status)
    ) {
      clearTimeout(live.timer);
      this.turns.delete(threadId);
      if (turn.status === "completed")
        live.resolve({ text: reply.text, threadId });
      else if (turn.status === "interrupted")
        live.resolve({ cancelled: true, text: reply.text, threadId });
      else {
        const error = new Error(
          `Codex 回合失败：${reply.error || "原生回合报告失败"}`,
        );
        error.terminalState = "failed";
        live.reject(error);
      }
    }
    return reply;
  }
  async interrupt(threadId, turnId) {
    await this.start();
    return this.request("turn/interrupt", { threadId, turnId });
  }
  async setThreadName(threadId, name) {
    await this.start();
    return this.request(
      "thread/name/set",
      { threadId, name: name.slice(0, 100) },
      5000,
    );
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.pending.clear();
    this.turns.clear();
    this.starting = null;
  }
  close() {
    this.fail(new Error("Codex 连接已关闭"));
    this.lines?.close();
    this.child?.kill();
    this.child = null;
  }
}

export function parseModelJSON(text) {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("Codex 未返回有效的结构化结果，请重试或手动填写计划");
  }
}
