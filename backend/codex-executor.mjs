import { parseModelJSON } from "./codex.mjs";
import { bufferedProgress } from "./progress.mjs";

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
      metadata: {
        progress: run.progress,
        threadId: run.contextId,
        turnId: run.turnId,
      },
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
      progress: {
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        stage: "会话已建立，正在发送原生回合",
        eventCount: 0,
      },
    };
    this.store.saveExecution(run); // Save the execution thread before starting model work.
    const reporter = bufferedProgress(
      run.progress,
      (progress) => {
        this.store.saveExecution({ ...this.store.execution(id), progress });
        this.notify(id);
      },
      this.isClosed,
    );
    const prompt = `你是 AI-Cooperation 的执行 Agent。按照所给任务、计划和反馈执行。工作区由宿主指定，所有修改限定在该工作区内。不得扩大权限、绕过沙箱或自行接受任务验收。汇报真实修改与验证结果；信息不足时提出具体疑问。最终答复只返回 JSON：{"status":"completed 或 needs_input","summary":"真实结果与证据","question":"有疑问时填写"}。completed 只表示本轮执行结束，仍须主调审核。以下是任务或主调的补充数据：\n${request.text}`;
    const effectivePrompt = request.directChat
      ? `你正在与用户直接对话，负责理解需求、制定方案、在指定工作目录内执行并验证。请先简短说明将如何处理，长任务每完成一个阶段及时给出公开进度。代码调查优先定向检索相关目录和候选文件，再做必要核对，避免无目标或重复的全仓遍历。按项目说明工作，不扩大权限或调查范围；不需要虚构主调或等待另一个 Agent 验收。普通问题直接回答，有疑问直接向用户提问，准确说明实际修改与验证情况。用户消息：\n${request.text}`
      : prompt;
    const finish = (state, value, usage) => {
      reporter.close();
      if (this.isClosed()) return;
      const latest = this.store.execution(id);
      this.store.saveExecution({
        ...latest,
        state,
        text: value,
        finishedAt: new Date().toISOString(),
        usage,
        progress: {
          ...reporter.value(),
          stage:
            state === "completed" ? "原生回合已完成" : "原生回合状态已更新",
          lastActivityAt: new Date().toISOString(),
        },
      });
      this.notify(id);
    };
    this.client
      .run(effectivePrompt, contextId, {
        threadPrepared: true,
        onStarted: ({ turnId }) => {
          if (!this.isClosed())
            this.store.saveExecution({ ...this.store.execution(id), turnId });
        },
        onProgress: reporter.update,
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
        finish(
          error.terminalState === "failed" ? "failed" : "unknown",
          `${error.terminalState === "failed" ? "Codex 执行失败" : "Codex 执行结果待核对"}：${error.message}`,
        );
      });
    const threadName =
      request.threadName ||
      this.store.tasks().find((t) => t.pending?.messageId === request.messageId)
        ?.goal;
    if (threadName)
      void this.client.setThreadName?.(contextId, threadName)?.catch(() => {});
    return this.result(run);
  }
  async poll(id) {
    const run = this.store.execution(id);
    const lastActivity = Date.parse(
      run.progress?.lastActivityAt || run.createdAt,
    );
    if (
      run.state === "working" &&
      run.turnId &&
      Date.now() - lastActivity > 90000 &&
      Date.now() - (run.lastProbeAt || 0) > 30000
    ) {
      this.store.saveExecution({ ...run, lastProbeAt: Date.now() });
      try {
        return await this.recover(id);
      } catch {
        /* A failed read is not proof that remote work stopped. */
      }
    }
    return this.result(this.store.execution(id));
  }
  async recover(id) {
    const run = this.store.execution(id);
    if (!run.turnId) throw new Error("原回合 ID 尚未确认，不能自动恢复或重发");
    const remote = await this.client.readTurn(run.contextId, run.turnId);
    if (["inProgress", "in_progress", "working"].includes(remote.status)) {
      const latest = this.store.execution(id);
      if (!["working", "unknown"].includes(latest.state))
        return this.result(latest);
      this.store.saveExecution({
        ...latest,
        state: "working",
        progress: {
          ...latest.progress,
          startedAt: latest.progress?.startedAt || latest.createdAt,
          lastActivityAt: new Date().toISOString(),
          stage: "已核对：Codex 原生回合仍在进行",
          publicMessage: remote.publicMessage || latest.progress?.publicMessage,
        },
        lastProbeAt: Date.now(),
      });
      return this.result(this.store.execution(id));
    }
    if (remote.status === "failed") {
      this.store.saveExecution({
        ...this.store.execution(id),
        state: "failed",
        text: `Codex 原生回合失败：${remote.error || "没有返回详情"}`,
        finishedAt: new Date().toISOString(),
      });
      return this.result(this.store.execution(id));
    }
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
      ...this.store.execution(id),
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
