import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _electron as electron, expect } from "@playwright/test";
import { DesktopService } from "../backend/service.mjs";
test(
  "desktop shows native public progress before the final reply and probes the same running turn",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aico-ui-progress-"));
    const cwd = path.join(root, "project");
    await mkdir(cwd);
    const s = new DesktopService({ root: path.join(root, "data") });
    s.store.saveConnection({
      id: "codex-local",
      name: "进度 fixture",
      kind: "codex",
      command: process.execPath,
      args: [path.resolve("test/fixtures/progress-server.mjs"), "5000"],
      model: "fixture",
    });
    await s.chats.saveProject({
      name: "实时进度",
      cwd,
      config: {
        mode: "single",
        coordinatorId: "",
        executorIds: ["codex-local"],
        maxRounds: 5,
      },
    });
    s.close();
    const app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICO_TEST: "1",
        AICO_DATA_DIR: path.join(root, "data"),
        AICO_NODE_EXEC: process.execPath,
      },
    });
    try {
      await app.evaluate(({ shell }) => {
        global.__cooperationDesktopLinks = [];
        shell.openExternal = async (url) => {
          global.__cooperationDesktopLinks.push(url);
        };
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByLabel("对话消息").fill("请看一下这个项目");
      await page.getByRole("button", { name: "发送消息 ↑" }).click();
      await page
        .getByText("已定位候选文件，正在核对", { exact: true })
        .waitFor();
      await page.getByText(/已用时/).waitFor();
      await page
        .getByRole("button", { name: "核对原回合", exact: true })
        .click();
      await page
        .getByText("已核对：Codex 原生回合仍在进行", { exact: true })
        .waitFor();
      await page.getByText("fixture final", { exact: true }).waitFor();
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs/native-progress-v071.png"),
        fullPage: true,
      });
      assert.equal(
        (await page.locator("body").innerText()).includes(
          "PRIVATE_REASONING_FIXTURE",
        ),
        false,
      );
      await page
        .locator(".conversation-message.assistant .message-text")
        .getByText("fixture final reply", { exact: true })
        .waitFor({ timeout: 12000 });
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(snapshot.conversations[0].status, "idle");
      assert.equal(snapshot.conversations.length, 1);
      assert.ok(snapshot.conversations[0].nativeThreadId);
      assert.ok(snapshot.conversations[0].nativeTurnId);
      const expected = `codex://threads/${snapshot.conversations[0].nativeThreadId}`;
      await page
        .getByRole("button", { name: "在 Codex 桌面打开原对话", exact: true })
        .click();
      assert.deepEqual(
        await app.evaluate(() => global.__cooperationDesktopLinks),
        [expected],
      );
      await page.getByRole("button", { name: /设置与说明/ }).click();
      await page
        .getByLabel("本轮结束后自动打开 Codex", { exact: true })
        .check();
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await page.getByText("设置已保存", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "请看一下这个项目", exact: true })
        .click();
      await page.getByLabel("对话消息").fill("继续核对");
      await page.getByRole("button", { name: "发送消息 ↑" }).click();
      await expect
        .poll(
          () => app.evaluate(() => global.__cooperationDesktopLinks.length),
          { timeout: 12000 },
        )
        .toBe(2);
      assert.deepEqual(
        await app.evaluate(() => global.__cooperationDesktopLinks),
        [expected, expected],
      );
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
    }
  },
);
