const BUILD = "0.7.0";
let cleanup;
const terminal = new Set(["completed", "input-required", "failed", "canceled"]);
function textOf(message) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  return (message.content || message.blocks || [])
    .filter((b) => b.type === "text" || b.kind === "text")
    .map((b) => b.text || "")
    .join("\n");
}
const pathKey = (value) =>
  String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
module.exports = {
  start(api) {
    if (api.process === "main") {
      delete require.cache[require.resolve("./gateway.cjs")];
      cleanup = require("./gateway.cjs").start(api);
      return;
    }
    const { ipcRenderer } = require("electron");
    const prefix = `aimanapp:t:${api.manifest.id}:cowork`;
    const invoke = (method, data) =>
      ipcRenderer.invoke(`${prefix}:${method}`, data);
    const native = async (method, data) => {
      try {
        return await ipcRenderer.invoke(method, data);
      } catch (error) {
        api.log?.warn?.(`Cowork native call failed: ${method}`);
        throw error;
      }
    };
    const running = new Map();
    let active = false,
      stopped = false;
    const saveRun = async (run, patch) => {
      if (
        Object.keys(patch).every(
          (key) => JSON.stringify(run[key]) === JSON.stringify(patch[key]),
        )
      )
        return;
      await invoke("run", { id: run.id, patch });
      Object.assign(run, patch);
    };
    async function catalog() {
      const [agents, projects] = await Promise.all([
        native("cowork:agents:list"),
        native("cowork:projects:list"),
      ]);
      const engines = [
        ...new Set(
          agents
            .filter((a) => ["mana", "codex", "claude"].includes(a.engine))
            .map((a) => a.engine),
        ),
      ];
      const models = {};
      for (const engine of engines) {
        const values = await native("cowork:agent:engineModels", { engine });
        models[engine] = values
          .map((v) =>
            typeof v === "string"
              ? { id: v, name: v }
              : {
                  id: v.value || v.id,
                  name: v.label || v.name || v.value || v.id,
                },
          )
          .filter((v) => typeof v.id === "string" && v.id);
      }
      return {
        protocol: "aico-cowork/1",
        build: BUILD,
        features: { directChat: true },
        agents: agents
          .filter((a) => models[a.engine]?.length)
          .map((a) => ({
            id: a.id,
            name: a.name,
            engine: a.engine,
            defaultModel: a.model || "",
            models: models[a.engine],
          })),
        projects: projects.map((p) => ({ name: p.name, cwd: p.cwd })),
        capabilities: {
          execute: true,
          sameSession: true,
          coordinator: false,
          cancel: true,
        },
      };
    }
    async function readSession(run) {
      const sessions = await native("cowork:sessions:list", {
        conversationId: run.conversationId,
      });
      const session = sessions.find((s) => s.id === run.conversationId);
      if (
        !session ||
        session.ownerSurface !== "cowork" ||
        session.agentId !== run.profile.agentId ||
        pathKey(session.projectCwd) !== pathKey(run.profile.cwd)
      )
        throw new Error("原会话绑定已变化");
      return session;
    }
    async function messages(run) {
      const value = await native("cowork:sessions:loadMessages", {
        id: run.conversationId,
        limit: 200,
      });
      return Array.isArray(value) ? value : value.messages || [];
    }
    async function poll(run) {
      const session = await readSession(run);
      const actualModel = session.model || run.profile.model;
      if (actualModel !== run.profile.model) {
        await saveRun(run, {
          actualModel,
          state: "auth-required",
          text: `AIMana 已切换模型：请求 ${run.profile.model}，实际 ${actualModel}。请在原会话核对，本轮结果暂不提交验收。`,
        });
        return;
      }
      if (session.pendingConfirmation || session.pendingPicker) {
        await saveRun(run, {
          state: "auth-required",
          text: "AIMana 请求用户确认或交互，请打开原 Cowork 会话处理，然后在协调器检查状态。",
        });
        return;
      }
      if (!run.ended) {
        if (run.state === "auth-required" && session.isRunning)
          await saveRun(run, { state: "working", text: "原会话继续执行" });
        return;
      }
      if (run.backgroundPending || session.isRunning) return;
      const fresh = (await messages(run)).filter(
        (m) =>
          m.role === "assistant" &&
          !(run.baseline || []).includes(m.id) &&
          (!m.turnId || m.turnId === run.turnId),
      );
      const last = fresh.at(-1),
        text = last ? textOf(last) : "";
      if (run.cancelled) {
        await saveRun(run, {
          state: "canceled",
          text: "AIMana 已确认原回合取消",
          actualModel,
        });
        return;
      }
      if (!text.trim()) {
        await saveRun(run, {
          state: "unknown",
          text: "原回合已结束，但未读到对应报告，请在原 Cowork 会话核对。",
        });
        return;
      }
      if (last.status && ["error", "failed", "stopped"].includes(last.status)) {
        await saveRun(run, { state: "failed", text, actualModel });
        return;
      }
      let report;
      try {
        report = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch {}
      const needsInput =
        report?.status === "needs_input" &&
        typeof report.question === "string" &&
        report.question.trim();
      await saveRun(run, {
        state: needsInput ? "input-required" : "completed",
        text: needsInput
          ? report.question
          : typeof report?.summary === "string"
            ? report.summary
            : text,
        actualModel,
      });
    }
    async function execute(method, data) {
      if (method === "inspect") return catalog();
      const run = data.run;
      running.set(run.conversationId || run.id, run);
      if (method === "send") {
        const info = await catalog();
        if (
          !info.agents
            .find((a) => a.id === run.profile.agentId)
            ?.models.some((m) => m.id === run.profile.model) ||
          !info.projects.some(
            (p) => pathKey(p.cwd) === pathKey(run.profile.cwd),
          )
        )
          throw new Error("模型或工作目录不可用");
        if (!run.conversationId) {
          const session = await native("cowork:sessions:create", {
            projectCwd: run.profile.cwd,
            title: "AI-Cooperation 协作任务",
            source: "new",
            sourceLabel: "AI-Cooperation",
            model: run.profile.model,
            modelChoiceSource: "manual",
            modeLabel: "询问模式",
            permissionMode: "ask",
            worktreeMode: "source",
            agentId: run.profile.agentId,
            ownerSurface: "cowork",
            speedMode: false,
          });
          await saveRun(run, {
            conversationId: session.id,
            contextId: `cowork-${session.id}`,
          });
        }
        const session = await readSession(run);
        if (
          session.isRunning ||
          session.pendingConfirmation ||
          session.pendingPicker ||
          session.model !== run.profile.model
        )
          throw new Error("原会话不空闲或模型已改变");
        await saveRun(run, {
          baseline: (await messages(run)).map((m) => m.id),
          state: "working",
          text: "正在调用原生 Cowork 回合",
        });
        running.delete(run.id);
        running.set(run.conversationId, run);
        const prompt = `你是 AI-Cooperation 的执行 Agent。按任务和反馈执行，修改限定在所给工作目录。报告真实产物和验证证据，完成后等待主控审核。需要补充任务信息时结束本轮并提出具体疑问。最终返回 JSON：{"status":"completed 或 needs_input","summary":"结果与证据","question":"需要回答的具体问题"}。任务数据：\n${data.text}`;
        await native(
          session.sdkSessionId || session.sdkConversationId
            ? "cowork:session:continue"
            : "cowork:session:start",
          {
            conversationId: run.conversationId,
            turnId: run.turnId,
            prompt: run.directChat
              ? `你正在与用户直接对话，由你理解需求、设计方案、在指定项目目录内执行并验证。不要虚构主调或等待其他 Agent 验收。有疑问直接向用户提问，遵守当前权限。最终返回 JSON：{"status":"completed 或 needs_input","summary":"给用户的答复与真实结果","question":"需要用户补充时填写"}。用户消息：\n${data.text}`
              : prompt,
            displayPrompt: data.text,
            projectCwd: run.profile.cwd,
            projectName: run.profile.cwd,
            agentId: run.profile.agentId,
            modelLabel: run.profile.model,
            permissionMode: "ask",
            speedMode: false,
          },
        );
        return true;
      }
      if (method === "poll") {
        await poll(run);
        return true;
      }
      if (method === "open") {
        await readSession(run);
        await native("cowork:floating-window:open", {
          conversationId: run.conversationId,
        });
        return true;
      }
      if (method === "cancel") {
        await readSession(run);
        await native("cowork:session:abort", {
          conversationId: run.conversationId,
          turnId: run.turnId,
        });
        return true;
      }
      throw new Error("未知操作");
    }
    const jobs = async (_event, job) => {
      if (!active || stopped) return;
      try {
        const value = await execute(job.method, job.data);
        await invoke("reply", { id: job.id, result: value });
      } catch {
        await invoke("reply", { id: job.id, error: true });
      }
    };
    const events = async (_event, value) => {
      if (!active || stopped) return;
      const payload = value?.scope
        ? value.scope.business === "cowork"
          ? { ...value.event, conversationId: value.execution.conversationId }
          : null
        : value;
      const run = payload && running.get(payload.conversationId);
      if (!run || payload.turnId !== run.turnId || terminal.has(run.state))
        return;
      try {
        if (payload.type === "turn_end") {
          await saveRun(run, {
            ended: true,
            cancelled: Boolean(payload.cancelled),
            backgroundPending: Boolean(
              payload.backgroundWorkPending || payload.dependentWorkPending,
            ),
          });
          await poll(run);
        }
      } catch {
        /* Keep pending; an idle window alone never proves completion. */
      }
    };
    ipcRenderer.on(`${prefix}:job`, jobs);
    ipcRenderer.on("cowork:conversation:event", events);
    ipcRenderer.on("agent-runtime:conversation:event", events);
    const hello = () =>
      invoke("hello")
        .then((info) => {
          if (stopped) return;
          const wasActive = active;
          active = info.active && info.build === BUILD;
          if (!wasActive && active)
            for (const run of info.runs || [])
              if (run.conversationId) running.set(run.conversationId, run);
        })
        .catch(() => {
          active = false;
        });
    hello();
    const heartbeat = setInterval(hello, 5000);
    const panel = api.settings.register({
      id: "cooperation",
      title: "AI-Cooperation · 普通 Cowork",
      render(root) {
        const version = document.createElement("p");
        version.textContent = `连接器 v${BUILD} · 普通 Cowork`;
        const hint = document.createElement("p");
        hint.textContent =
          "在协调器生成配对码，配对后回协调器选择 Agent、模型和工作目录。使用已有 Cowork 权限及账号额度。";
        const code = document.createElement("input");
        code.setAttribute("aria-label", "AI-Cooperation 配对码");
        code.placeholder = "粘贴 AI-Cooperation 配对码";
        const button = document.createElement("button");
        button.textContent = "配对普通 Cowork";
        const status = document.createElement("p");
        status.setAttribute("role", "status");
        button.onclick = async () => {
          button.disabled = true;
          try {
            const reply = await invoke("pair", { code: code.value.trim() });
            status.textContent = reply.ok
              ? "配对成功。请回协调器选择 Agent、模型和目录。"
              : reply.message;
            if (reply.ok) code.value = "";
          } catch {
            status.textContent = "主进程未响应，请重载连接插件";
          } finally {
            button.disabled = false;
          }
        };
        root.append(version, hint, code, button, status);
        return () => {
          button.onclick = null;
          root.replaceChildren();
        };
      },
    });
    cleanup = () => {
      stopped = true;
      clearInterval(heartbeat);
      ipcRenderer.removeListener(`${prefix}:job`, jobs);
      ipcRenderer.removeListener("cowork:conversation:event", events);
      ipcRenderer.removeListener("agent-runtime:conversation:event", events);
      panel.unregister();
    };
  },
  stop() {
    cleanup?.();
    cleanup = undefined;
  },
};
