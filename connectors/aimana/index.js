// User-initiated pairing only. No credential logging, persistence, or automatic token rotation.
let cleanup;
const pairingErrors = {
  invalid_code: "配对码格式不正确，请完整复制协调器生成的配对码。",
  expired_code: "配对码已过期或已使用，请回协调器生成新码。",
  coordinator_unreachable:
    "无法连接 AI-Cooperation。请保持协调器运行，并使用当前窗口生成的新配对码。",
  agent_disabled:
    "选中的 Agent 尚未启用 Workspace，或配置已变化。请检查原生设置后重新读取 Agent。",
  missing_token:
    "选中的 Agent 没有原生连接凭据，请在 AIMana 原生 Workspace 设置中检查该 Agent。",
  token_unavailable:
    "无法读取原生 Agent 连接凭据，请检查 AIMana 的凭据设置；连接器不会自动重置凭据。",
  service_unavailable:
    "AIMana 本机服务未能启动，请在原生 Workspace 设置中检查服务状态。",
  card_unavailable: "AIMana 本机服务未响应 Agent Card，请检查服务状态后重试。",
  card_unauthorized: "AIMana 拒绝访问这个 Agent，请检查原生 Agent 的连接权限。",
  agent_unavailable:
    "本机服务没有提供选中的 Agent，请重新读取 Agent 并检查 Workspace 状态。",
  invalid_card: "AIMana 返回的 Agent Card 不兼容，请检查软件版本。",
  secure_storage_failed:
    "协调器无法加密保存连接凭据，请检查 Windows 安全存储是否可用。",
  connection_save_failed:
    "协调器未能保存 Agent 连接，请检查该连接是否正在执行任务。",
};
function failure(code) {
  return {
    ok: false,
    code,
    message:
      pairingErrors[code] || "配对未完成，请更新协调器与连接插件后重试。",
  };
}
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
        if (!match || Number(match[1]) > 65535 || Number(match[1]) < 1)
          return failure("invalid_code");
        let response;
        try {
          response = await fetch(`http://127.0.0.1:${match[1]}/pair`, {
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
        } catch {
          return failure("coordinator_unreachable");
        }
        if (!response.ok) {
          let body;
          try {
            body = await response.json();
          } catch {}
          if (body?.code && pairingErrors[body.code]) return failure(body.code);
          return response.status === 403
            ? failure("expired_code")
            : {
                ok: false,
                message: `协调器拒绝配对（HTTP ${response.status}）。请更新到 0.3.1 后生成新码查看具体原因。`,
              };
        }
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
            const config = await ipcRenderer.invoke("a2a:config:get");
            if (
              !config.agents?.some(
                (agent) => agent.agentId === agents.value && agent.enabled,
              )
            ) {
              status.textContent = pairingErrors.agent_disabled;
              return;
            }
            status.textContent = "正在检查 AIMana 本机服务…";
            const state = await ipcRenderer.invoke("a2a:server:status");
            if (state?.phase !== "running") {
              status.textContent = "正在启动已配置的 AIMana 本机服务…";
              let restarted;
              try {
                restarted = await ipcRenderer.invoke("a2a:server:retry");
              } catch {
                status.textContent = pairingErrors.service_unavailable;
                return;
              }
              if (restarted?.phase !== "running") {
                status.textContent = pairingErrors.service_unavailable;
                return;
              }
            }
            let secret;
            try {
              secret = await ipcRenderer.invoke(
                "a2a:token:reveal",
                agents.value,
              );
            } catch {
              status.textContent = pairingErrors.token_unavailable;
              return;
            }
            if (!secret?.token) {
              status.textContent = pairingErrors.missing_token;
              return;
            }
            status.textContent = "正在与协调器配对并加密保存连接…";
            const result = await api.ipc.invoke("pair", {
              code: code.value.trim(),
              agentId: agents.value,
              token: secret.token,
            });
            if (!result?.ok) {
              status.textContent =
                result?.message || "连接插件返回不兼容，请重载插件后重试。";
              return;
            }
            code.value = "";
            status.textContent = "配对成功，可以回 AI-Cooperation 派发任务。";
          } catch {
            status.textContent =
              "无法完成配对调用。请重载 AIMana++ 连接插件，并确认 AIMana 原生 Workspace 接口可用。";
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
