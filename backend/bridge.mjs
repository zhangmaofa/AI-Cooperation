import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";

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
          reply(403, { error: "配对码无效或已过期，请生成新的配对码" });
          return;
        }
        pairing.state = "processing";
        if (
          typeof data.agentId !== "string" ||
          !data.agentId ||
          data.agentId.length > 200 ||
          typeof data.token !== "string" ||
          !data.token ||
          data.token.length > 16000
        )
          throw new Error("AIMana 连接信息不完整");
        const endpoint = `http://127.0.0.1:${aimanaPort}/a2a/v0.3/agents/${encodeURIComponent(data.agentId)}`;
        const check = await fetch(endpoint + "/.well-known/agent-card.json", {
          headers: { Authorization: `Bearer ${data.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (!check.ok)
          throw new Error(`本机 AIMana Agent 验证失败：HTTP ${check.status}`);
        const card = await check.json();
        if (!card.name || !card.capabilities)
          throw new Error("AIMana 未返回有效 Agent Card");
        if (!saveSecret)
          throw new Error(
            "当前运行方式不支持加密保存配对凭据，请使用桌面客户端",
          );
        const tokenRef = await saveSecret(data.token);
        const existing = service.store
          .connections()
          .find((c) => c.endpoint === endpoint);
        const result = await service.handle("connection.save", {
          id: existing?.id,
          name: String(card.name).slice(0, 100),
          kind: "a2a",
          endpoint,
          tokenRef,
        });
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
        pairing = { state: "failed", expires: Date.now() + 120000 };
      reply(400, {
        error:
          request.url === "/pair"
            ? "配对未完成。请确认 Agent 已启用 Workspace 并生成新的配对码重试。"
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
