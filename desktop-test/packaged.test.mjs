import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const executablePath = path.resolve("release/win-unpacked/AI-Cooperation.exe");
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
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs", "desktop-packaged.png"),
      });
    } finally {
      await app.close();
    }
  },
);
