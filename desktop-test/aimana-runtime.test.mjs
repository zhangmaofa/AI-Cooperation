import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _electron as electron } from "@playwright/test";
import { DesktopService } from "../backend/service.mjs";
import { startBridge } from "../backend/bridge.mjs";
import { CoworkClient } from "../src/cowork.mjs";

const runtime = path.join(
  process.env.LOCALAPPDATA || "",
  ".aimana-plusplus",
  "runtime",
);
async function until(action, predicate) {
  for (let i = 0; i < 80; i++) {
    const r = await action();
    if (predicate(r)) return r;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture condition timed out");
}
test(
  "ordinary Cowork gateway pairs through installed sandbox runtime, selects profiles and keeps question/rework on original session",
  { timeout: 60000, skip: !existsSync(path.join(runtime, "main.cjs")) },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aico-cowork-runtime-"));
    const tempRuntime = path.join(root, "runtime"),
      tweak = path.join(root, "tweaks/com.zhangmaofa.ai-cooperation"),
      workspace = path.join(root, "workspace"),
      data = path.join(root, "coordinator");
    for (const dir of [tempRuntime, tweak, workspace, data])
      await mkdir(dir, { recursive: true });
    for (const name of ["main.cjs", "preload.cjs"])
      await copyFile(path.join(runtime, name), path.join(tempRuntime, name));
    for (const name of ["index.js", "gateway.cjs", "manifest.json"])
      await copyFile(
        path.resolve("connectors/aimana", name),
        path.join(tweak, name),
      );
    const vault = new Map();
    const service = new DesktopService({
      root: data,
      secret: async (ref) => vault.get(ref),
    });
    const bridge = await startBridge(service, {
      root: data,
      saveSecret: async (value) => {
        vault.set("fixture-ref", value);
        return "fixture-ref";
      },
    });
    let app;
    try {
      app = await electron.launch({
        args: [path.resolve("test/fixtures/aimana-runtime.cjs")],
        env: {
          ...process.env,
          AIMANAPP_USER_ROOT: root,
          AIMANAPP_RUNTIME: tempRuntime,
          AIMANAPP_WORKSPACE: workspace,
        },
      });
      const page = await app.firstWindow();
      await page.locator("#aimanapp-panel").waitFor({ state: "attached" });
      await page.keyboard.press("Control+Alt+u");
      await page
        .getByText("连接器 v0.5.0 · 普通 Cowork", { exact: true })
        .waitFor();
      const pair = bridge.startPairing();
      await page.getByLabel("AI-Cooperation 配对码").fill(pair.code);
      await page
        .getByRole("button", { name: "配对普通 Cowork", exact: true })
        .click();
      await page
        .getByText("配对成功。请回协调器选择 Agent、模型和目录。", {
          exact: true,
        })
        .waitFor();
      assert.equal(bridge.pairingStatus().state, "paired");
      let connection = service
        .snapshot()
        .connections.find((c) => c.kind === "aimana");
      assert.equal(connection.catalog.agents.length, 2);
      assert.deepEqual(
        connection.catalog.agents
          .find((a) => a.id === "writer")
          .models.map((m) => m.id),
        ["model-small", "model-large"],
      );
      await assert.rejects(
        service.handle("connection.profile", {
          id: connection.id,
          agentId: "coder",
          model: "model-small",
          cwd: workspace,
          name: "invalid",
        }),
      );
      await service.handle("connection.profile", {
        id: connection.id,
        agentId: "writer",
        model: "model-small",
        cwd: workspace,
        name: "文档低成本执行器",
      });
      const clone = await service.handle("connection.profile", {
        id: connection.id,
        agentId: "coder",
        model: "model-code",
        cwd: workspace,
        name: "编码执行器",
        clone: true,
      });
      assert.notEqual(clone.id, connection.id);
      const create = () =>
        service.create({
          goal: "write fixture artifact",
          plan: ["write"],
          acceptance: ["artifact exists"],
          mode: "real",
          connectionId: connection.id,
          workspace,
          maxRounds: 4,
          contract: { stopOnNoProgress: false },
        });
      let task = await create();
      task = await service.action(task.id, "dispatch");
      assert.equal(task.status, "working");
      const context = task.contextId,
        firstId = task.remoteTaskId;
      const sessionId = task.result.remote.metadata.conversationId;
      await app.evaluate((_e, id) => global.fixture.stale(id), sessionId);
      task = await service.action(task.id, "poll");
      assert.equal(task.status, "working");
      await app.evaluate(
        (_e, id) =>
          global.fixture.finish(id, {
            status: "needs_input",
            question: "需要哪种格式？",
          }),
        sessionId,
      );
      await until(
        () => service.action(task.id, "poll"),
        (t) => t.status === "needs_input",
      );
      task = await service.action(task.id, "answer", { text: "UTF-8" });
      assert.equal(task.contextId, context);
      assert.notEqual(task.remoteTaskId, firstId);
      await app.evaluate(
        (_e, id) => global.fixture.permission(id, true),
        sessionId,
      );
      task = await service.action(task.id, "poll");
      assert.equal(task.status, "needs_user");
      await service.action(task.id, "open-session");
      assert.equal(
        (await app.evaluate(() => global.fixture.snapshot())).opened,
        sessionId,
      );
      await app.evaluate(
        (_e, id) => global.fixture.permission(id, false),
        sessionId,
      );
      await app.evaluate(
        (_e, id) =>
          global.fixture.finish(id, {
            status: "completed",
            summary: "first version",
          }),
        sessionId,
      );
      task = await until(
        async () => {
          await service.tick();
          await service.drainBackground();
          return service.store.task(task.id);
        },
        (t) => t.status === "pending_review",
      );
      task = await service.action(task.id, "review", {
        decision: "revise",
        feedback: "change report",
        evidence: [],
      });
      task = await service.action(task.id, "dispatch");
      assert.equal(task.contextId, context);
      await app.evaluate(
        (_e, id) =>
          global.fixture.finish(id, {
            status: "completed",
            summary: "revised version",
          }),
        sessionId,
      );
      task = await until(
        () => service.action(task.id, "poll"),
        (t) => t.status === "pending_review",
      );
      assert.equal(
        await readFile(path.join(workspace, "result.txt"), "utf8"),
        "revised version",
      );
      task = await service.action(task.id, "review", {
        decision: "accept",
        feedback: "checked artifact",
        evidence: [
          {
            criterionId: "C1",
            passed: true,
            reference: "fixture file inspected",
          },
        ],
      });
      assert.equal(task.status, "accepted");
      assert.equal(
        (await app.evaluate(() => global.fixture.snapshot())).sessions.length,
        1,
      );
      // Native automatic model fallback must not silently pass review.
      let changed = await create();
      changed = await service.action(changed.id, "dispatch");
      const changedId = changed.result.remote.metadata.conversationId;
      await app.evaluate(
        (_e, id) => global.fixture.switchModel(id, "model-large"),
        changedId,
      );
      changed = await service.action(changed.id, "poll");
      assert.equal(changed.status, "needs_user");
      assert.match(changed.result.text, /实际 model-large/);
      // Send dedupe is durable and conflicting reuse cannot start another turn.
      connection = service.store.connection(connection.id);
      const client = new CoworkClient(connection, {
        tokenProvider: async () => vault.get("fixture-ref"),
      });
      const req = {
        messageId: "dedupe-fixture",
        text: "fixture",
        contextId: null,
        taskId: null,
      };
      const once = await client.send(req),
        twice = await client.send(req);
      assert.equal(once.id, twice.id);
      await assert.rejects(client.send({ ...req, text: "different" }));
      const count = (await app.evaluate(() => global.fixture.snapshot()))
        .starts;
      const forbidden = await fetch(connection.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "bad", method: "inspect" }),
      });
      assert.equal(forbidden.status, 403);
      // Hot reload preserves bridge address, credential and journal; no repeat sends.
      await page.getByRole("button", { name: "重载", exact: true }).click();
      await until(
        () => client.poll(once.id).catch(() => null),
        (v) => v?.status.state === "unknown",
      );
      assert.equal(
        (await app.evaluate(() => global.fixture.snapshot())).starts,
        count,
      );
      await client.cancel(once.id);
      await until(
        () => client.poll(once.id),
        (v) => v.status.state === "canceled",
      );
      const snapshot = JSON.stringify(service.snapshot());
      assert.equal(snapshot.includes(vault.get("fixture-ref")), false);
      const journal = await readFile(
        path.join(
          root,
          "tweak-data/com.zhangmaofa.ai-cooperation/cowork-state.json",
        ),
        "utf8",
      );
      assert.equal(journal.includes(vault.get("fixture-ref")), false);
    } finally {
      if (app) await app.close();
      await bridge.close();
      service.close();
    }
  },
);
