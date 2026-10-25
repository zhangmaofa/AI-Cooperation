import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DesktopService } from "../backend/service.mjs";
import { startBridge } from "../backend/bridge.mjs";

test("authenticated desktop MCP uses the same SQLite backend and keeps owner binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-bridge-"));
  const service = new DesktopService({ root });
  const bridge = await startBridge(service, { root });
  const client = new Client({ name: "bridge-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp.mjs", import.meta.url)), "--desktop"],
    env: { ...process.env, AICO_DATA_DIR: root },
  });
  try {
    const record = JSON.parse(await readFile(bridge.file, "utf8"));
    assert.equal(
      (await fetch(record.url, { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(record.url, {
          method: "POST",
          headers: { Origin: "https://example.com" },
          body: "{}",
        })
      ).status,
      403,
    );
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "cooperation_review"));
    let result = await client.callTool({
      name: "cooperation_create",
      arguments: {
        ownerThreadId: "original-external-main",
        goal: "Bridge fixture",
        plan: ["Implement"],
        acceptance: ["Artifact"],
        connectionId: "codex-local",
        workspace: root,
        maxRounds: 2,
      },
    });
    assert.equal(Boolean(result.isError), false);
    const task = JSON.parse(result.content[0].text);
    assert.equal(service.snapshot().tasks[0].id, task.id);
    assert.equal(
      service.store.task(task.id).ownerThreadId,
      "original-external-main",
    );
    result = await client.callTool({
      name: "cooperation_action",
      arguments: {
        id: task.id,
        ownerThreadId: "different-main",
        action: "dispatch",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(service.store.task(task.id).status, "ready");
  } finally {
    await client.close();
    await bridge.close();
    service.close();
  }
});

test("AIMana pairing is one-time, validates a local card, and keeps native token out of snapshots and connection records", async () => {
  const nativeToken = "native-a2a-fixture-only";
  let encryptedRef;
  const card = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${nativeToken}`);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ name: "Fixture native AIMana", capabilities: {} }),
    );
  });
  await new Promise((resolve) => card.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-pairing-"));
  const service = new DesktopService({ root });
  const bridge = await startBridge(service, {
    root,
    aimanaPort: card.address().port,
    saveSecret: async (token) => {
      assert.equal(token, nativeToken);
      encryptedRef = "vault-fixture-ref";
      return encryptedRef;
    },
  });
  try {
    const pairing = bridge.startPairing();
    const port = pairing.code.split(".")[0];
    const url = `http://127.0.0.1:${port}/pair`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pairing.code,
        agentId: "fixture-agent",
        token: nativeToken,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(bridge.pairingStatus().state, "paired");
    assert.equal(
      service.store.connections().find((c) => c.kind === "a2a").tokenRef,
      encryptedRef,
    );
    assert.equal(
      JSON.stringify(service.snapshot()).includes(nativeToken),
      false,
    );
    assert.equal(
      JSON.stringify(service.snapshot()).includes(encryptedRef),
      false,
    );
    assert.equal(
      JSON.stringify(service.store.connections()).includes(nativeToken),
      false,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          body: JSON.stringify({
            code: pairing.code,
            agentId: "fixture-agent",
            token: nativeToken,
          }),
        })
      ).status,
      403,
    );
  } finally {
    await bridge.close();
    service.close();
    await new Promise((resolve) => card.close(resolve));
  }
});
