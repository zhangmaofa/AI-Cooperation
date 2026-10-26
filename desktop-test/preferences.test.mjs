import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

test(
  "appearance previews, system changes, persistence, large font layout and safe draft cleanup",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aico-appearance-"));
    const options = {
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICO_TEST: "1",
        AICO_DATA_DIR: root,
        AICO_NODE_EXEC: process.execPath,
      },
    };
    let app;
    const errors = [];
    async function theme(page) {
      return page.evaluate(() => ({
        mode: document.documentElement.dataset.theme,
        accent: document.documentElement.dataset.accent,
        size: parseFloat(
          getComputedStyle(document.querySelector("h1")).fontSize,
        ),
        color: getComputedStyle(document.documentElement).color,
        background: getComputedStyle(document.documentElement).backgroundColor,
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
    }
    try {
      app = await electron.launch(options);
      let page = await app.firstWindow();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.getByRole("button", { name: /设置与说明/ }).click();
      await page.getByLabel("明暗模式").selectOption("light");
      await page.getByLabel("字体大小").selectOption("1");
      const small = await theme(page);
      await page.getByRole("button", { name: "紫罗兰" }).click();
      await page.getByLabel("明暗模式").selectOption("dark");
      await expect
        .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
        .toBe("dark");
      await page.getByLabel("字体大小").selectOption("1.5");
      const large = await theme(page);
      assert.equal(large.mode, "dark");
      assert.equal(large.accent, "purple");
      assert.ok(Math.abs(large.size / small.size - 1.5) < 0.01);
      assert.ok(large.width <= large.viewport, JSON.stringify(large));
      assert.notEqual(large.background, small.background);
      await page.getByLabel("启用桌面通知").uncheck();
      // Leaving an unsaved preview restores the SQLite preferences.
      await page.getByRole("button", { name: /Agent 连接/ }).click();
      assert.equal((await theme(page)).accent, "green");
      await expect
        .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
        .toBe("system");
      await page.getByRole("button", { name: /设置与说明/ }).click();
      await page.getByLabel("明暗模式").selectOption("dark");
      await page.getByLabel("字体大小").selectOption("1.5");
      await page.getByRole("button", { name: "紫罗兰" }).click();
      await page.getByLabel("启用桌面通知").uncheck();
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await page.getByText("设置已保存", { exact: true }).waitFor();
      assert.equal(
        await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
        "dark",
      );
      await mkdir("outputs", { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve("outputs/settings-dark-v060.png"),
        fullPage: true,
      });
      const saved = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.deepEqual(saved.preferences, {
        mode: "dark",
        accent: "purple",
        fontScale: 1.5,
        notifications: false,
      });
      await app.close();
      app = undefined;
      app = await electron.launch(options);
      page = await app.firstWindow();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByRole("button", { name: /设置与说明/ }).click();
      assert.equal(await page.getByLabel("明暗模式").inputValue(), "dark");
      assert.equal(await page.getByLabel("字体大小").inputValue(), "1.5");
      assert.equal(await page.getByLabel("启用桌面通知").isChecked(), false);
      await page.getByRole("button", { name: /任务工作台/ }).click();
      await page.getByRole("button", { name: "运行模拟演示" }).click();
      await page.getByText("Agent 的疑问", { exact: true }).waitFor();
      assert.ok((await theme(page)).width <= (await theme(page)).viewport);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve("outputs/task-dark-v060.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "新建协作任务", exact: true })
        .click();
      assert.equal(
        await page
          .getByLabel("任务目标")
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        16.5,
      );
      assert.ok(
        await page
          .locator(".modal")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      );
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("button", { name: /设置与说明/ }).click();
      await page.getByLabel("明暗模式").selectOption("system");
      await expect
        .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
        .toBe("system");
      await page.emulateMedia({ colorScheme: "light" });
      assert.equal((await theme(page)).mode, "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "dark",
      );
      await page
        .getByRole("button", { name: "恢复默认设置", exact: true })
        .click();
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await page.getByText("设置已保存", { exact: true }).waitFor();
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "light",
      );
      for (const [label, accent] of [
        ["海洋蓝", "blue"],
        ["琥珀橙", "orange"],
        ["森林绿", "green"],
      ]) {
        await page.getByRole("button", { name: label }).click();
        assert.equal((await theme(page)).accent, accent);
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve("outputs/settings-light-v060.png"),
        fullPage: true,
      });
      // Clear only form drafts after explicit confirmation, preserve preferences.
      await page.evaluate(() => {
        localStorage.setItem(
          "ai-cooperation:draft:v1:task.goal",
          JSON.stringify("待提交目标"),
        );
        localStorage.setItem(
          "ai-cooperation:draft:v1:workflow.goal",
          JSON.stringify("待提交计划"),
        );
      });
      await page
        .getByRole("button", { name: "清空未提交草稿", exact: true })
        .click();
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("ai-cooperation:draft:v1:task.goal"),
        ),
        '"待提交目标"',
      );
      await page.getByRole("button", { name: "保留草稿", exact: true }).click();
      await page
        .getByRole("button", { name: "清空未提交草稿", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认清空草稿", exact: true })
        .click();
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("ai-cooperation:draft:v1:task.goal"),
        ),
        null,
      );
      assert.ok(
        await page.evaluate(() =>
          localStorage.getItem("ai-cooperation:preferences:v1"),
        ),
      );
      assert.equal(
        (await page.evaluate(() => window.cooperation.request("snapshot")))
          .tasks.length,
        1,
      );
      await page.getByRole("button", { name: /任务工作台/ }).click();
      await page
        .getByRole("button", { name: "新建协作任务", exact: true })
        .click();
      await page.getByLabel("任务目标").waitFor();
      assert.deepEqual(errors, []);
    } finally {
      if (app) await app.close();
    }
  },
);
