import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { _electron as electron } from "@playwright/test";

test(
  "desktop pairs ordinary Cowork and saves distinct Agent/model executor profiles",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "aico-cowork-profile-ui-"),
    );
    const project = path.join(root, "project");
    await mkdir(project);
    const token = "fixture-local-gateway-credential-00001";
    const catalog = {
      protocol: "aico-cowork/1",
      agents: [
        {
          id: "writer",
          name: "文档 Agent",
          engine: "mana",
          defaultModel: "small",
          models: [
            { id: "small", name: "Small" },
            { id: "large", name: "Large" },
          ],
        },
        {
          id: "coder",
          name: "编码 Agent",
          engine: "claude",
          defaultModel: "code",
          models: [{ id: "code", name: "Code" }],
        },
      ],
      projects: [{ name: "测试项目", cwd: project }],
    };
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const p of req) raw += p;
      const v = JSON.parse(raw);
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(v.method, "inspect");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: v.id, result: catalog }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let app;
    try {
      app = await electron.launch({
        args: ["."],
        cwd: process.cwd(),
        env: {
          ...process.env,
          AICO_TEST: "1",
          AICO_DATA_DIR: root,
          AICO_NODE_EXEC: process.execPath,
        },
      });
      const page = await app.firstWindow();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByRole("button", { name: /Agent 连接/ }).click();
      await page
        .getByRole("button", { name: "生成配对码", exact: true })
        .click();
      const code = await page.getByLabel("短时配对码").inputValue();
      const port = code.split(".")[0];
      const paired = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          transport: "cowork",
          endpoint: `http://127.0.0.1:${server.address().port}/cowork`,
          token,
        }),
      });
      assert.equal(paired.status, 200);
      const card = page
        .locator(".agent-card")
        .filter({
          has: page.getByRole("heading", {
            name: "本机 AIMana Cowork",
            exact: true,
          }),
        });
      await card.getByRole("button", { name: "配置连接", exact: true }).click();
      await page
        .getByLabel("AIMana Agent", { exact: true })
        .selectOption("writer");
      assert.equal(
        await page.getByLabel("AIMana 模型", { exact: true }).inputValue(),
        "small",
      );
      await page
        .getByLabel("AIMana 工作目录", { exact: true })
        .selectOption(project);
      await page.getByLabel("执行器名称", { exact: true }).fill("文档执行器");
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs/desktop-cowork-profile-editor.png"),
      });
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      const doc = page
        .locator(".agent-card")
        .filter({
          has: page.getByRole("heading", { name: "文档执行器", exact: true }),
        });
      await doc.getByRole("button", { name: "配置连接", exact: true }).click();
      await page
        .getByLabel("AIMana Agent", { exact: true })
        .selectOption("coder");
      assert.equal(
        await page.getByLabel("AIMana 模型", { exact: true }).inputValue(),
        "code",
      );
      await page.getByLabel("执行器名称", { exact: true }).fill("编码执行器");
      await page
        .getByRole("button", { name: "保存为另一个执行器", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "编码执行器", exact: true })
        .waitFor();
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      const profiles = snapshot.connections.filter((c) => c.kind === "aimana");
      assert.equal(profiles.length, 2);
      assert.equal(profiles.find((c) => c.agentId === "writer").model, "small");
      assert.equal(profiles.find((c) => c.agentId === "coder").model, "code");
      assert.equal(JSON.stringify(snapshot).includes(token), false);
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs/desktop-cowork-profiles.png"),
      });
      assert.deepEqual(errors, []);
    } finally {
      if (app) await app.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
