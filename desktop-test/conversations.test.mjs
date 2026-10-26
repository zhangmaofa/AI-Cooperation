import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _electron as electron } from "@playwright/test";
import { DesktopService } from "../backend/service.mjs";

test(
  "desktop project conversations execute single and distributed modes through isolated native Codex protocol, then restore history",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aico-project-desktop-"));
    const workspace = path.join(root, "project");
    await mkdir(workspace);
    const native = path.join(root, "native"),
      data = path.join(root, "data");
    const service = new DesktopService({ root: data });
    for (const [id, name, model] of [
      ["codex-local", "主调 Codex", "fixture-main"],
      ["worker-a", "经济模型 A", "fixture-cheap-a"],
      ["worker-b", "经济模型 B", "fixture-cheap-b"],
    ])
      service.store.saveConnection({
        id,
        name,
        kind: "codex",
        model,
        command: process.execPath,
        args: [path.resolve("test/fixtures/conversation-server.mjs"), native],
        cwd: root,
      });
    service.close();
    const options = {
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICO_TEST: "1",
        AICO_DATA_DIR: data,
        AICO_NODE_EXEC: process.execPath,
      },
    };
    let app;
    const errors = [];
    try {
      app = await electron.launch(options);
      let page = await app.firstWindow();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.getByRole("heading", { name: "从一个项目开始" }).waitFor();
      await page.getByRole("button", { name: "添加第一个项目" }).click();
      const dialog = page.getByRole("dialog", {
        name: "新建项目",
        exact: true,
      });
      await dialog.getByLabel("项目名称").fill("项目协作体验");
      await dialog.getByLabel("项目工作目录").fill(workspace);
      await dialog
        .getByLabel("对话执行 Agent", { exact: true })
        .selectOption("worker-a");
      await dialog.getByRole("button", { name: "保存项目" }).click();
      await page
        .getByRole("heading", { name: "今天想在这个项目里完成什么？" })
        .waitFor();
      await mkdir("outputs", { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve("outputs/project-welcome-v070.png"),
        fullPage: true,
      });
      await page.getByLabel("对话消息").fill("请设计并完成第一项工作");
      await page.getByRole("button", { name: "发送消息 ↑" }).click();
      await page
        .locator(".conversation-message.assistant")
        .first()
        .waitFor({ timeout: 20000 });
      const first = await page.evaluate(async () => {
        const s = await window.cooperation.request("snapshot");
        return window.cooperation.request("conversation.read", {
          id: s.conversations[0].id,
        });
      });
      assert.equal(first.config.mode, "single");
      assert.equal(first.workspace, workspace);
      await page.getByLabel("对话消息").fill("继续检查结果并回复");
      await page.getByRole("button", { name: "发送消息 ↑" }).click();
      await page
        .locator(".conversation-message.assistant")
        .nth(1)
        .waitFor({ timeout: 20000 });
      const continued = await page.evaluate(
        (id) => window.cooperation.request("conversation.read", { id }),
        first.id,
      );
      assert.equal(continued.contextId, first.contextId);
      assert.match(
        await readFile(path.join(workspace, "fixture-cheap-a.txt"), "utf8"),
        /artifact/,
      );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve("outputs/project-direct-v070.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "＋ 在此项目新建对话", exact: true })
        .click();
      await page.getByRole("button", { name: /AI-Cooperation 协作/ }).click();
      await page
        .getByLabel("对话主调 Agent", { exact: true })
        .selectOption("codex-local");
      await page.getByLabel("执行器 经济模型 B", { exact: true }).check();
      // Snapshot refreshes must not overwrite the user's unsaved mode selection.
      await page.evaluate(() =>
        window.cooperation.request("preferences.save", {
          mode: "light",
          accent: "blue",
          fontScale: 1.3,
          notifications: false,
        }),
      );
      assert.equal(
        await page.getByLabel("执行器 经济模型 B", { exact: true }).isChecked(),
        true,
      );
      await page
        .getByLabel("对话消息")
        .fill("让两个执行器分别交付，再由主调整体验证");
      await page.getByRole("button", { name: "发送消息 ↑" }).click();
      await page
        .getByRole("heading", { name: "主调的协作计划", exact: true })
        .waitFor({ timeout: 20000 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve("outputs/project-plan-v070.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "开始协作", exact: true }).click();
      await page
        .getByText("总体验收通过", { exact: true })
        .waitFor({ timeout: 40000 });
      await page
        .getByText(/本次协作已通过主调总体验收/)
        .waitFor({ timeout: 10000 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve("outputs/project-completed-v070.png"),
        fullPage: true,
      });
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.conversations.length, 2);
      assert.equal(snapshot.tasks.length, 2);
      assert.ok(
        snapshot.tasks.every(
          (t) =>
            t.status === "accepted" &&
            t.executor.cwd === workspace &&
            t.coordinatorProfile.cwd === workspace,
        ),
      );
      const lines = (await readFile(path.join(native, "calls.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.ok(lines.every((l) => l.cwd === workspace));
      assert.ok(
        lines.some(
          (l) => l.sandbox === "read-only" && l.model === "fixture-main",
        ),
      );
      assert.ok(
        lines.some(
          (l) =>
            l.sandbox === "workspace-write" && l.model === "fixture-cheap-b",
        ),
      );
      const active = snapshot.conversations.find(
        (c) => c.config.mode === "distributed",
      );
      await app.close();
      app = undefined;
      app = await electron.launch(options);
      page = await app.firstWindow();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByText(/本次协作已通过主调总体验收/).waitFor();
      assert.equal(
        (
          await page.evaluate(
            (id) => window.cooperation.request("conversation.read", { id }),
            active.id,
          )
        ).config.mode,
        "distributed",
      );
      await page
        .getByRole("button", { name: first.title, exact: true })
        .click();
      await page.locator(".conversation-message.assistant").nth(1).waitFor();
      await page.getByText(/单 Agent · 直接对话/).waitFor();
      assert.deepEqual(errors, []);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    } catch (error) {
      if (app) {
        const page = await app.firstWindow();
        const debug = await page.evaluate(async () => ({ body: document.body.innerText, selected: localStorage.getItem("ai-cooperation:conversation"), snapshot: await window.cooperation.request("snapshot") }));
        await writeFile(path.resolve("outputs/project-desktop-failure.json"), JSON.stringify({ errors, debug }, null, 2));
        await page.screenshot({ path: path.resolve("outputs/project-desktop-failure.png"), fullPage: true });
      }
      throw error;
    } finally {
      if (app) await app.close();
    }
  },
);
