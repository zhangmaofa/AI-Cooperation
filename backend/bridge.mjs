import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { CoworkClient } from "../src/cowork.mjs";

const equal = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
const methods = new Set([
  "snapshot",
  "task.create",
  "task.action",
  "workflow.start",
  "workflow.review",
]);
class PairingFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export async function startBridge(
  service,
  { root, saveSecret, aimanaPort = 43119 },
) {
  const token = randomBytes(32).toString("hex");
  let pairing;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    const reply = (status, body) => {
      response.statusCode = status;
      response.end(JSON.stringify(body));
    };
    if (
      request.method !== "POST" ||
      request.headers.origin ||
      !/^127\.0\.0\.1:\d+$/.test(request.headers.host || "")
    ) {
      reply(403, { error: "Local authenticated clients only" });
      return;
    }
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 256000) {
          reply(413, { error: "Request too large" });
          return;
        }
      }
      const data = JSON.parse(raw);
      if (request.url === "/pair") {
        if (
          !pairing ||
          pairing.expires < Date.now() ||
          !equal(data.code, pairing.code) ||
          pairing.state !== "pending"
        ) {
          reply(403, {
            code: "expired_code",
            error: "配对码无效或已过期，请生成新的配对码",
          });
          return;
        }
        pairing.state = "processing";
        if (data.transport === "cowork") {
          if (
            typeof data.token !== "string" ||
            data.token.length < 32 ||
            data.token.length > 200
          )
            throw new PairingFailure(
              "invalid_connection_details",
              "Cowork 连接信息无效",
            );
          let catalog;
          try {
            catalog = await new CoworkClient(
              { endpoint: data.endpoint },
              { tokenProvider: async () => data.token },
            ).inspect();
          } catch {
            throw new PairingFailure(
              "cowork_unavailable",
              "无法连接 Cowork 插件。请保持 AIMana 窗口打开，并重载最新版连接插件。",
            );
          }
          if (
            catalog?.protocol !== "aico-cowork/1" ||
            !Array.isArray(catalog.agents) ||
            !Array.isArray(catalog.projects)
          )
            throw new PairingFailure(
              "invalid_card",
              "Cowork 插件返回不兼容的能力目录",
            );
          if (!saveSecret)
            throw new PairingFailure(
              "secure_storage_failed",
              "请使用支持加密存储的桌面客户端",
            );
          let tokenRef;
          try {
            tokenRef = await saveSecret(data.token);
          } catch {
            throw new PairingFailure(
              "secure_storage_failed",
              "无法加密保存插件配对凭据",
            );
          }
          const existing = service.store
            .connections()
            .find((c) => c.kind === "aimana" && c.endpoint === data.endpoint);
          const id = existing?.id || randomBytes(16).toString("hex");
          if (
            existing &&
            service.store
              .tasks()
              .some((t) => t.executor.connectionId === id && t.lease)
          )
            throw new PairingFailure(
              "connection_save_failed",
              "连接仍有任务，请先核对原会话后再配对",
            );
          service.store.saveConnection({
            ...existing,
            id,
            kind: "aimana",
            name: existing?.name || "本机 AIMana Cowork",
            endpoint: data.endpoint,
            tokenRef,
            catalog: {
              build: catalog.build,
              features: catalog.features,
              agents: catalog.agents,
              projects: catalog.projects,
            },
            status: "connected",
            lastMessage: "插件已连接，请选择 Agent、模型和工作目录",
          });
          service.changed();
          pairing = {
            state: "paired",
            connectionId: id,
            expires: Date.now() + 120000,
          };
          reply(200, { ok: true });
          return;
        }
        if (
          typeof data.agentId !== "string" ||
          !data.agentId ||
          data.agentId.length > 200 ||
          typeof data.token !== "string" ||
          !data.token ||
          data.token.length > 16000
        )
          throw new PairingFailure(
            "invalid_connection_details",
            "AIMana 连接信息不完整，请重载连接插件",
          );
        const endpoint = `http://127.0.0.1:${aimanaPort}/a2a/v0.3/agents/${encodeURIComponent(data.agentId)}`;
        let check;
        try {
          check = await fetch(endpoint + "/.well-known/agent-card.json", {
            headers: { Authorization: `Bearer ${data.token}` },
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
        } catch {
          throw new PairingFailure(
            "card_unavailable",
            "AIMana 本机接口 127.0.0.1:43119 未响应，请在 AIMana 连接插件中检查并启动本机服务",
          );
        }
        if (!check.ok)
          throw new PairingFailure(
            check.status === 401 || check.status === 403
              ? "card_unauthorized"
              : check.status === 404
                ? "agent_unavailable"
                : "card_unavailable",
            `AIMana Agent Card 返回 HTTP ${check.status}`,
          );
        let card;
        try {
          card = await check.json();
        } catch {
          throw new PairingFailure(
            "invalid_card",
            "AIMana 未返回有效 Agent Card",
          );
        }
        if (!card.name || !card.capabilities)
          throw new PairingFailure(
            "invalid_card",
            "AIMana 未返回有效 Agent Card",
          );
        if (!saveSecret)
          throw new PairingFailure(
            "secure_storage_failed",
            "当前运行方式不支持加密保存配对凭据，请使用桌面客户端",
          );
        let tokenRef;
        try {
          tokenRef = await saveSecret(data.token);
        } catch {
          throw new PairingFailure(
            "secure_storage_failed",
            "Windows 安全存储未能加密保存连接凭据",
          );
        }
        const existing = service.store
          .connections()
          .find((c) => c.endpoint === endpoint);
        let result;
        try {
          result = await service.handle("connection.save", {
            id: existing?.id,
            name: String(card.name).slice(0, 100),
            kind: "a2a",
            endpoint,
            tokenRef,
          });
        } catch {
          throw new PairingFailure(
            "connection_save_failed",
            "协调器未能保存连接，请检查该连接是否正在执行任务",
          );
        }
        pairing = {
          state: "paired",
          connectionId: result.id,
          expires: Date.now() + 120000,
        };
        reply(200, { ok: true, name: card.name });
        return;
      }
      if (
        request.url !== "/rpc" ||
        !equal(request.headers.authorization, `Bearer ${token}`)
      ) {
        reply(401, { error: "Unauthorized" });
        return;
      }
      if (!methods.has(data.method)) throw new Error("该本地工具操作不受支持");
      const input = data.data || {};
      if (data.method === "task.action") {
        const task = service.store.task(input.id);
        if (!input.ownerThreadId || task.ownerThreadId !== input.ownerThreadId)
          throw new Error("任务不属于这个主控会话");
      }
      reply(200, { result: await service.handle(data.method, input) });
    } catch (error) {
      if (request.url === "/pair" && pairing?.state === "processing")
        pairing = {
          state: "failed",
          failureCode:
            error instanceof PairingFailure ? error.code : "pairing_failed",
          error:
            error instanceof PairingFailure
              ? error.message
              : "配对请求处理失败，请重载连接插件后重试",
          expires: Date.now() + 120000,
        };
      reply(400, {
        ...(request.url === "/pair"
          ? { code: pairing?.failureCode || "pairing_failed" }
          : {}),
        error:
          request.url === "/pair"
            ? pairing?.error || "配对请求处理失败，请更新协调器与连接插件"
            : String(error.message).slice(0, 600),
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port,
    file = path.join(root, "bridge.json");
  await writeFile(
    file,
    JSON.stringify({
      url: `http://127.0.0.1:${port}/rpc`,
      token,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
  return {
    file,
    startPairing() {
      pairing = {
        code: `${port}.${randomBytes(18).toString("hex")}`,
        state: "pending",
        expires: Date.now() + 120000,
      };
      return { code: pairing.code, expires: pairing.expires };
    },
    pairingStatus() {
      return {
        state:
          !pairing || pairing.expires < Date.now() ? "expired" : pairing.state,
        connectionId: pairing?.connectionId,
        ...(pairing?.state === "failed"
          ? { code: pairing.failureCode, error: pairing.error }
          : {}),
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      try {
        const record = JSON.parse(await readFile(file, "utf8"));
        if (record.token === token) await unlink(file);
      } catch {}
    },
  };
}
