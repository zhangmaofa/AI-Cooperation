import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

test(
  "desktop exposes durable workflows, scheduler, pairing and shared MCP configuration",
  { timeout: 60000 },
  async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "aico-collaboration-ui-"),
    );
    const app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICO_TEST: "1",
        AICO_DATA_DIR: dataDir,
        AICO_NODE_EXEC: process.execPath,
      },
    });
    try {
      const page = await app.firstWindow();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: /协作计划/ }).click();
      await page.getByRole("heading", { name: "制定新的协作计划" }).waitFor();
      await page
        .getByLabel("协作总体目标")
        .fill("UI fixture only; do not invoke models");
      assert.equal(
        await page
          .getByRole("button", { name: "让主控制定协作计划" })
          .isEnabled(),
        true,
      );
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs/desktop-workflows.png"),
      });
      await page.getByRole("button", { name: /设置与说明/ }).click();
      await page.getByLabel("最多同时执行", { exact: true }).fill("3");
      await page.getByRole("button", { name: "保存调度设置" }).click();
      await page.waitForFunction(
        async () =>
          (await window.cooperation.request("snapshot")).scheduler
            .maxConcurrent === 3,
      );
      await page.getByRole("button", { name: "显示本机 MCP 启动配置" }).click();
      await page.getByText('"--desktop"', { exact: false }).waitFor();
      await page.getByRole("button", { name: /Agent 连接/ }).click();
      await page.getByRole("button", { name: "生成配对码" }).click();
      const code = await page.getByLabel("短时配对码").inputValue();
      assert.match(code, /^\d+\.[a-f0-9]{36}$/);
      await page.getByRole("button", { name: "检查配对结果" }).click();
      await page.getByText("等待 AIMana 确认配对。", { exact: true }).waitFor();
      await page.getByRole("button", { name: "添加连接", exact: true }).click();
      await page.getByLabel("连接类型").selectOption("acp");
      await page.getByLabel("连接名称").fill("ACP UI fixture");
      await page.getByLabel("Codex 程序路径").fill("fixture-acp.exe");
      await page.getByLabel("ACP 启动参数").fill('["--acp"]');
      await page.getByRole("button", { name: "保存连接", exact: true }).click();
      await page
        .getByRole("heading", { name: "ACP UI fixture", exact: true })
        .waitFor();
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(
        snapshot.connections.find((c) => c.kind === "acp").args[0],
        "--acp",
      );
      assert.equal(JSON.stringify(snapshot).includes(code), false);
      const bridge = JSON.parse(
        await readFile(path.join(dataDir, "bridge.json"), "utf8"),
      );
      assert.equal(JSON.stringify(snapshot).includes(bridge.token), false);
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
    }
  },
);
