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
    };
    this.store.saveExecution(run); // Save the execution thread before starting model work.
    const prompt = `你是 AI-Cooperation 的执行 Agent。按照所给任务、计划和反馈执行。工作区由宿主指定，所有修改限定在该工作区内。不得扩大权限、绕过沙箱或自行接受任务验收。汇报真实修改与验证结果；信息不足时提出具体疑问。最终答复只返回 JSON：{"status":"completed 或 needs_input","summary":"真实结果与证据","question":"有疑问时填写"}。completed 只表示本轮执行结束，仍须主调审核。以下是任务或主调的补充数据：\n${request.text}`;
    const finish = (state, value) => {
      if (this.isClosed()) return;
      const latest = this.store.execution(id);
      this.store.saveExecution({
        ...latest,
        state,
        text: value,
        finishedAt: new Date().toISOString(),
      });
      this.notify();
    };
    this.client
      .run(prompt, contextId, {
        threadPrepared: true,
        onStarted: ({ turnId }) => {
          if (!this.isClosed())
            this.store.saveExecution({ ...this.store.execution(id), turnId });
        },
      })
      .then((response) => {
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
}
