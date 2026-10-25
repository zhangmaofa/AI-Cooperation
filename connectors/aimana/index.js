// User-initiated pairing only. No credential logging, persistence, or automatic token rotation.
let cleanup;
module.exports = {
  start(api) {
    if (api.process === "main") {
      const channel = `aimanapp:t:${api.manifest.id}:pair`;
      const { ipcMain } = require("electron");
      ipcMain.removeHandler(channel);
      api.ipc.handle("pair", async (_event, input) => {
        // AIMana++ passes handler payload as the first argument; support both IPC wrappers.
        input ||= _event;
        const match = /^(\d{1,5})\.([a-f0-9]{36})$/.exec(input.code || "");
        if (!match || Number(match[1]) > 65535)
          throw new Error("请粘贴 AI-Cooperation 显示的完整配对码");
        const response = await fetch(`http://127.0.0.1:${match[1]}/pair`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: input.code,
            agentId: input.agentId,
            token: input.token,
          }),
        });
        if (!response.ok)
          throw new Error("配对失败，请确认协调器仍在运行并重新生成配对码");
        return { ok: true };
      });
      cleanup = () => ipcMain.removeHandler(channel);
      return;
    }
    const { ipcRenderer } = require("electron");
    const handle = api.settings.register({
      id: "cooperation",
      title: "AI-Cooperation 协作连接",
      render(root) {
        const text = document.createElement("p");
        text.textContent =
          "在协调器生成配对码，选择已启用 Workspace 的 Agent 后配对。使用现有账号额度；连接凭据自动加密保存。";
        const code = document.createElement("input");
        code.placeholder = "粘贴 AI-Cooperation 配对码";
        code.setAttribute("aria-label", "AI-Cooperation 配对码");
        const agents = document.createElement("select");
        agents.setAttribute("aria-label", "配对 Agent");
        const refresh = document.createElement("button");
        refresh.textContent = "读取已启用的 Agent";
        const pair = document.createElement("button");
        pair.textContent = "配对选中 Agent";
        const status = document.createElement("p");
        status.setAttribute("role", "status");
        refresh.onclick = async () => {
          try {
            const config = await ipcRenderer.invoke("a2a:config:get");
            agents.replaceChildren();
            for (const agent of config.agents || [])
              if (agent.enabled) {
                const option = document.createElement("option");
                option.value = agent.agentId;
                option.textContent =
                  agent.name || agent.agentName || agent.agentId;
                agents.append(option);
              }
            status.textContent = agents.options.length
              ? "请选择 Agent 并点击配对。"
              : "没有已启用的 Agent。请先在 Agent 的 Workspace 设置中配置模型、工作目录并启用。";
          } catch {
            status.textContent =
              "无法读取 Agent。请检查 AIMana 版本和 Workspace 设置。";
          }
        };
        pair.onclick = async () => {
          if (!agents.value || !code.value.trim()) {
            status.textContent = "请先选择 Agent 并粘贴配对码。";
            return;
          }
          pair.disabled = true;
          try {
            const secret = await ipcRenderer.invoke(
              "a2a:token:reveal",
              agents.value,
            );
            if (!secret?.token)
              throw new Error(
                "当前 Agent 没有连接凭据，请先在原生设置中启用 Workspace",
              );
            await api.ipc.invoke("pair", {
              code: code.value.trim(),
              agentId: agents.value,
              token: secret.token,
            });
            code.value = "";
            status.textContent = "配对成功，可以回 AI-Cooperation 派发任务。";
          } catch {
            status.textContent =
              "配对未完成。请检查 Agent 已启用 Workspace，重新生成配对码再试。";
          } finally {
            pair.disabled = false;
          }
        };
        root.append(text, code, agents, refresh, pair, status);
        return () => {
          refresh.onclick = null;
          pair.onclick = null;
          root.replaceChildren();
        };
      },
    });
    cleanup = () => handle.unregister();
  },
  stop() {
    cleanup?.();
    cleanup = null;
  },
};
