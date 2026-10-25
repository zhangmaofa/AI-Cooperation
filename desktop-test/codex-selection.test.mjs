import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

test(
  "new real task can select the existing Codex as executor without any A2A connection",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aico-codex-selection-"));
    const app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICO_TEST: "1",
        AICO_DATA_DIR: root,
        AICO_NODE_EXEC: process.execPath,
      },
    });
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "新建协作任务" }).click();
      await page
        .getByRole("button", { name: "真实 Agent", exact: true })
        .click();
      assert.equal(
        await page.getByLabel("执行 Agent", { exact: true }).inputValue(),
        "codex-local",
      );
      await page
        .getByText("还不能开工：请选择执行工作目录，再创建任务。", {
          exact: true,
        })
        .waitFor();
      await page
        .getByLabel("任务目标", { exact: true })
        .fill("Codex execution selection test");
      await page
        .getByLabel("执行计划", { exact: true })
        .fill("Create a scoped file");
      await page
        .getByLabel("验收标准", { exact: true })
        .fill("File content matches");
      assert.equal(
        await page
          .getByRole("button", { name: "创建任务", exact: true })
          .isDisabled(),
        true,
      );
      await page.getByLabel("执行工作目录", { exact: true }).fill(root);
      await page.getByRole("button", { name: "创建任务", exact: true }).click();
      await page
        .getByRole("button", { name: "开始执行", exact: true })
        .waitFor();
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(snapshot.tasks[0].executor.type, "codex");
      assert.equal(snapshot.tasks[0].executor.cwd, root);
      assert.equal(snapshot.tasks[0].status, "ready");
    } finally {
      await app.close();
    }
  },
);
