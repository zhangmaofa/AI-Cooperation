import test from "node:test";
import assert from "node:assert/strict";
import { _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test(
  "Windows client: demo clarification, reject/revise, accept and restart persistence",
  { timeout: 90000 },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "aico-desktop-test-"));
    const launch = () =>
      electron.launch({
        args: ["."],
        cwd: process.cwd(),
        env: {
          ...process.env,
          AICO_TEST: "1",
          AICO_DATA_DIR: dataDir,
          AICO_NODE_EXEC: process.execPath,
        },
      });
    let app = await launch();
    const errors = [];
    try {
      let page = await app.firstWindow();
      await page.getByRole("button", { name: /任务工作台/ }).click();
      page.on("pageerror", (error) => errors.push(error.message));
      await mkdir("outputs", { recursive: true });
      await page.getByRole("heading", { name: /任务工作台/ }).waitFor();
      await page.screenshot({
        path: path.resolve("outputs", "desktop-home.png"),
      });
      await page.getByRole("button", { name: "运行模拟演示" }).click();
      await page.getByText("Agent 的疑问", { exact: true }).waitFor();
      const firstContext = await page.evaluate(
        async () =>
          (await window.cooperation.request("snapshot")).tasks[0].contextId,
      );
      await page
        .getByLabel("答复并继续原会话")
        .fill("请覆盖本次约定的全部交付，并给出逐项验证步骤。");
      await page.getByRole("button", { name: "发送答复" }).click();
      await page.getByText("审核这次交付", { exact: true }).waitFor();
      await page
        .getByLabel("审核意见 / 修改要求")
        .fill("缺少验证步骤，请补充后重新交付。");
      await page.getByRole("button", { name: "要求修改" }).click();
      await page.getByRole("button", { name: "在原会话继续返工" }).click();
      await page.getByText("审核这次交付", { exact: true }).waitFor();
      await page
        .getByLabel("审核意见 / 修改要求")
        .fill("已检查模拟交付内容，流程符合预期。");
      await page.getByLabel("C1 验收证据").fill("模拟证据：范围清单检查完成");
      await page.getByLabel("C2 验收证据").fill("模拟证据：验证步骤检查完成");
      await page.screenshot({
        path: path.resolve("outputs", "desktop-review.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "验收通过" }).click();
      await page.getByText("任务已验收", { exact: true }).waitFor();
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(snapshot.tasks[0].status, "accepted");
      assert.equal(snapshot.tasks[0].contextId, firstContext);
      await page.getByRole("button", { name: /Agent 连接/ }).click();
      await page
        .getByRole("heading", { name: "本机 Codex", exact: true })
        .waitFor();
      await page.screenshot({
        path: path.resolve("outputs", "desktop-agents.png"),
      });
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await page.getByRole("button", { name: /任务工作台/ }).click();
      await page
        .getByText("整理项目交付清单，并补充验证步骤", { exact: true })
        .waitFor();
      const saved = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(saved.tasks[0].status, "accepted");
      assert.equal(saved.tasks[0].contextId, firstContext);
      assert.deepEqual(errors, []);
    } catch (error) {
      const page = app.windows()[0];
      if (page) {
        await mkdir("outputs", { recursive: true });
        await page
          .screenshot({ path: path.resolve("outputs", "desktop-failure.png") })
          .catch(() => {});
        console.error(
          "Renderer errors:",
          errors,
          "Visible text:",
          (
            await page
              .locator("body")
              .innerText()
              .catch(() => "")
          ).slice(0, 1400),
        );
      }
      throw error;
    } finally {
      await app.close();
    }
  },
);
