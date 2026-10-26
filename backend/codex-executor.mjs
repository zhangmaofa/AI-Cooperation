import { parseModelJSON } from "./codex.mjs";

export class CodexExecutor {
  constructor({ store, client, notify = () => {}, isClosed = () => false }) {
    this.store = store;
    this.client = client;
    this.notify = notify;
    this.isClosed = isClosed;
  }
  result(run) {
    return {
      kind: "task",
      id: run.id,
      contextId: run.contextId,
      status: {
        state: run.state,
        message: {
          parts: [
            {
              kind: "text",
              text: run.text || "Codex 正在指定工作目录中执行任务。",
            },
          ],
        },
      },
    };
  }
  async send(request) {
    const id = `codex-${request.messageId}`;
    const existing = this.store.executions().find((run) => run.id === id);
    if (existing) return this.result(existing);
    if (request.taskId) {
      const prior = this.store.execution(request.taskId);
      if (
        prior.contextId !== request.contextId ||
        prior.state !== "input-required"
      )
        throw new Error("答复与原 Codex 执行会话不匹配");
    }
    const contextId = await this.client.openThread(request.contextId);
    const run = {
      id,
      contextId,
      state: "working",
      text: "",
      turnId: null,
      createdAt: new Date().toISOString(),
      connectionId: this.client.connection?.id || request.connectionId,
    };
    this.store.saveExecution(run); // Save the execution thread before starting model work.
    const prompt = `你是 AI-Cooperation 的执行 Agent。按照所给任务、计划和反馈执行。工作区由宿主指定，所有修改限定在该工作区内。不得扩大权限、绕过沙箱或自行接受任务验收。汇报真实修改与验证结果；信息不足时提出具体疑问。最终答复只返回 JSON：{"status":"completed 或 needs_input","summary":"真实结果与证据","question":"有疑问时填写"}。completed 只表示本轮执行结束，仍须主调审核。以下是任务或主调的补充数据：\n${request.text}`;
    const effectivePrompt = request.directChat
      ? `你正在与用户直接对话，负责理解需求、制定方案、在指定工作目录内执行并验证。按项目说明工作，不扩大权限；不需要虚构主调或等待另一个 Agent 验收。普通问题直接回答，有疑问直接向用户提问，准确说明实际修改与验证情况。用户消息：\n${request.text}`
      : prompt;
    const finish = (state, value, usage) => {
      if (this.isClosed()) return;
      const latest = this.store.execution(id);
      this.store.saveExecution({
        ...latest,
        state,
        text: value,
        finishedAt: new Date().toISOString(),
        usage,
      });
      this.notify();
    };
    this.client
      .run(effectivePrompt, contextId, {
        threadPrepared: true,
        onStarted: ({ turnId }) => {
          if (!this.isClosed())
            this.store.saveExecution({ ...this.store.execution(id), turnId });
        },
      })
      .then((response) => {
        if (response.needsUser) {
          finish(
            "auth-required",
            "目标 Agent 请求权限。协调器未自动批准，请在原软件核对权限与配置。",
          );
          return;
        }
        if (response.cancelled) {
          finish("canceled", "目标 Agent 已确认本轮取消");
          return;
        }
        let report;
        try {
          report = parseModelJSON(response.text);
        } catch {
          /* Completed turn with plain text remains a report requiring review. */
        }
        if (
          report?.status === "needs_input" &&
          typeof report.question === "string" &&
          report.question.trim()
        )
          finish("input-required", report.question);
        else
          finish(
            "completed",
            typeof report?.summary === "string"
              ? report.summary
              : response.text ||
                  "Codex 本轮执行结束，但没有返回报告。请主调检查实际产物。",
            response.usage,
          );
      })
      .catch((error) => {
        // Disconnection/timeout does not prove that remote work stopped or failed.
        finish("unknown", `Codex 执行结果待核对：${error.message}`);
      });
    return this.result(run);
  }
  async poll(id) {
    return this.result(this.store.execution(id));
  }
  async recover(id) {
    const run = this.store.execution(id);
    if (!run.turnId) throw new Error("原回合 ID 尚未确认，不能自动恢复或重发");
    const remote = await this.client.readTurn(run.contextId, run.turnId);
    if (remote.status === "interrupted") {
      this.store.saveExecution({
        ...run,
        state: "canceled",
        text: "原执行回合已确认中断",
      });
      return this.result(this.store.execution(id));
    }
    if (remote.status !== "completed")
      throw new Error(`原执行轮次仍为 ${remote.status}，请保留会话并稍后核对`);
    let report;
    try {
      report = parseModelJSON(remote.text);
    } catch {}
    this.store.saveExecution({
      ...run,
      state: report?.status === "needs_input" ? "input-required" : "completed",
      text: report?.question || report?.summary || remote.text,
      recoveredAt: new Date().toISOString(),
    });
    return this.result(this.store.execution(id));
  }
  async cancel(id) {
    const run = this.store.execution(id);
    if (!run.turnId) throw new Error("尚未取得回合 ID，请先核对远端");
    await this.client.interrupt(run.contextId, run.turnId);
    // Interrupt acknowledgement is not a terminal fact. Recovery must confirm the outcome.
    return { requested: true };
  }
}
