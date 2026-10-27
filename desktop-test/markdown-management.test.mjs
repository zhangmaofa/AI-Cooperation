import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _electron as electron, expect } from "@playwright/test";
import { DesktopService } from "../backend/service.mjs";
test(
  "desktop renders stored Markdown with safe actionable links and removes/restores project history without touching source files",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "aico-markdown-desktop-"),
      ),
      workspace = path.join(root, "project"),
      data = path.join(root, "data");
    await mkdir(workspace);
    const source = path.join(workspace, "Example.cs");
    await writeFile(
      source,
      Array.from({ length: 240 }, (_, i) => `source line ${i + 1}`).join("\n"),
    );
    const markdown = [
      "## 报告结论",
      "",
      "这是 **领域模型**，包含 `Example`。",
      "",
      "| 层次 | 代码 |",
      "|---|---|",
      `| Domain | [Example.cs](${source.replaceAll("\\", "/")}:116) |`,
      "",
      "- 已完成",
      "- 待验证",
      "",
      "```js",
      String.raw`const text = "literal\n";`,
      "```",
      "",
      "[项目目录](./)",
      "",
      "[官方网站](https://example.com/docs)",
      "",
      "[不安全链接](javascript:alert%281%29)",
      "",
      "![远端图片](https://example.com/tracker.png)",
      "",
      "<script>window.unsafeExecuted=true</script>",
    ].join("\n");
    const s = new DesktopService({ root: data });
    const p = await s.chats.saveProject({
        name: "显示与管理",
        cwd: workspace,
        config: {
          mode: "single",
          coordinatorId: "",
          executorIds: ["codex-local"],
          maxRounds: 5,
        },
      }),
      chat = await s.chats.create({ projectId: p.id });
    chat.title = "已保存报告";
    s.chats.append(chat, "assistant", markdown);
    s.chats.save(chat);
    s.close();
    const app = await electron.launch({
      ...(process.env.AICO_TEST_PACKAGED_EXEC
        ? { executablePath: process.env.AICO_TEST_PACKAGED_EXEC }
        : { args: ["."] }),
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICO_TEST: "1",
        AICO_DATA_DIR: data,
        AICO_NODE_EXEC: process.execPath,
      },
    });
    const errors = [];
    try {
      await app.evaluate(({ clipboard, shell }) => {
        globalThis.copied = [];
        globalThis.opened = [];
        globalThis.revealed = [];
        clipboard.writeText = (text) => globalThis.copied.push(text);
        shell.openExternal = async (url) => globalThis.opened.push(url);
        shell.showItemInFolder = (p) => globalThis.revealed.push(p);
      });
      const page = await app.firstWindow();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width: 1280, height: 900 });
      const fetched = [];
      page.on("request", (req) => fetched.push(req.url()));
      await page
        .getByRole("button", { name: "已保存报告", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "报告结论", exact: true })
        .waitFor();
      assert.equal(
        await page.locator(".markdown-body table tbody tr").count(),
        1,
      );
      assert.equal(
        await page.locator(".markdown-body strong").textContent(),
        "领域模型",
      );
      assert.equal(
        await page.locator(".markdown-body img, .markdown-body script").count(),
        0,
      );
      assert.equal(
        await page.locator('.markdown-body a[href^="javascript:"]').count(),
        0,
      );
      await page.getByRole("button", { name: "复制代码", exact: true }).click();
      assert.match(
        (await app.evaluate(() => globalThis.copied)).at(-1),
        /literal\\n/,
      );
      await page.getByRole("button", { name: "复制原文", exact: true }).click();
      assert.equal(
        (await app.evaluate(() => globalThis.copied)).at(-1),
        markdown,
      );
      await page.getByRole("link", { name: "官方网站", exact: true }).click();
      assert.equal(
        (await app.evaluate(() => globalThis.opened)).at(-1),
        "https://example.com/docs",
      );
      await page.getByRole("link", { name: "Example.cs", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "项目文件预览" });
      await preview.waitFor();
      await expect(preview.getByLabel("定位到第 116 行")).toBeVisible();
      await expect(preview.locator(".target-line code")).toHaveText(
        "source line 116",
      );
      await preview.getByRole("button", { name: "在文件管理器中显示" }).click();
      assert.equal(
        (await app.evaluate(() => globalThis.revealed)).at(-1).toLowerCase(),
        source.toLowerCase(),
      );
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await page.getByRole("link", { name: "项目目录", exact: true }).click();
      await expect(
        preview.getByRole("button", { name: /Example.cs/ }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs/markdown-management-v072.png"),
        fullPage: true,
      });
      await page.getByLabel("已保存报告的操作", { exact: true }).click();
      await page.getByRole("button", { name: "移除对话", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "已保存报告", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: /已移除（/ }).click();
      let bin = page.getByRole("region", { name: "已移除的项目和对话" });
      await expect(bin.getByText("对话 · 已保存报告")).toBeVisible();
      await bin.getByRole("button", { name: "恢复", exact: true }).click();
      await page
        .getByRole("button", { name: "已保存报告", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "报告结论", exact: true })
        .waitFor();
      await page.getByLabel("显示与管理的操作", { exact: true }).click();
      await page.getByRole("button", { name: "移除项目", exact: true }).click();
      await page.getByRole("heading", { name: "从一个项目开始" }).waitFor();
      await expect(bin.getByText("项目 · 显示与管理")).toBeVisible();
      await bin.getByRole("button", { name: "恢复", exact: true }).click();
      await page
        .getByRole("button", { name: "已保存报告", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "报告结论", exact: true })
        .waitFor();
      await page.reload();
      await page
        .getByRole("heading", { name: "报告结论", exact: true })
        .waitFor();
      const stored = await page.evaluate(
        (id) => window.cooperation.request("conversation.read", { id }),
        chat.id,
      );
      assert.equal(stored.messages[0].text, markdown);
      assert.equal(await page.evaluate(() => window.unsafeExecuted), undefined);
      assert.ok(!fetched.some((url) => url.includes("tracker.png")));
      assert.deepEqual(errors, []);
      assert.match(await readFile(source, "utf8"), /source line 116/);
    } catch (error) {
      const page = await app.firstWindow();
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs/markdown-management-failure.png"),
        fullPage: true,
      });
      throw error;
    } finally {
      await app.close();
    }
  },
);
