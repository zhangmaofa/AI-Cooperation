import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const executablePath = path.resolve(
  "release",
  JSON.parse(readFileSync("package.json", "utf8")).version,
  "win-unpacked",
  "AI-Cooperation.exe",
);
test(
  "packaged Windows app uses bundled Node runtime and persists a real SQLite task",
  { timeout: 45000, skip: !existsSync(executablePath) },
  async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "aico-packaged-test-"),
    );
    const app = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        AICO_TEST: "1",
        AICO_DATA_DIR: dataDir,
        AICO_NODE_EXEC: "C:\\must-not-use-system-node.exe",
      },
    });
    try {
      assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
      const page = await app.firstWindow();
      await page.getByRole("button", { name: /任务工作台/ }).click();
      await page.getByRole("heading", { name: /任务工作台/ }).waitFor();
      await page.getByRole("button", { name: "运行模拟演示" }).click();
      await page.getByText("Agent 的疑问", { exact: true }).waitFor();
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(snapshot.tasks[0].status, "needs_input");
      assert.equal(existsSync(path.join(dataDir, "cooperation.sqlite")), true);
      await page.getByRole("button", { name: /Agent 连接/ }).click();
      await page
        .getByRole("heading", { name: "本机 Codex", exact: true })
        .waitFor();
      await page.getByRole("button", { name: /设置与说明/ }).click();
      await page
        .getByLabel("本轮结束后自动打开 Codex", { exact: true })
        .waitFor();
      await page.getByLabel("明暗模式").selectOption("dark");
      await page.getByRole("button", { name: "海洋蓝" }).click();
      await page.getByLabel("字体大小").selectOption("1.3");
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await page.getByText("设置已保存", { exact: true }).waitFor();
      const settings = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(settings.preferences.accent, "blue");
      assert.equal(settings.preferences.fontScale, 1.3);
      assert.equal(settings.preferences.autoOpenCodex, false);
      const workspace = path.join(dataDir, "project");
      await mkdir(workspace);
      await page.getByRole("button", { name: "新建项目", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "新建项目",
        exact: true,
      });
      await dialog.getByLabel("项目名称").fill("打包项目");
      await dialog.getByLabel("项目工作目录").fill(workspace);
      await dialog
        .getByLabel("对话执行 Agent", { exact: true })
        .selectOption("codex-local");
      await dialog
        .getByRole("button", { name: "保存项目", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "今天想在这个项目里完成什么？" })
        .waitFor();
      const project = await page.evaluate(
        async () => (await window.cooperation.request("snapshot")).projects[0],
      );
      assert.equal(project.cwd, workspace);
      const conversation = await page.evaluate(
        (projectId) =>
          window.cooperation.request("conversation.create", { projectId }),
        project.id,
      );
      assert.equal(conversation.workspace, workspace);
      assert.equal(conversation.config.mode, "single");
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs", "desktop-packaged.png"),
      });
    } finally {
      await app.close();
    }
  },
);
