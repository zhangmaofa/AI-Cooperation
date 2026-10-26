import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { DesktopService } from "../backend/service.mjs";

test(
  "workflow editor checks cycles, keeps drafts across navigation/restart and exposes pause plus actionable inbox",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "aico-workflow-experience-"),
      ),
      workspace = path.join(root, "project");
    await mkdir(workspace);
    const service = new DesktopService({
      root,
      codexCommand: "fixture-not-launched.exe",
    });
    service.store.setSetting("plan:fixture", {
      goal: "体验回归计划",
      coordinatorId: "codex-local",
    });
    const base = {
      id: "A",
      goal: "第一项",
      plan: ["检查输入"],
      acceptance: ["结果可检查"],
      dependsOn: [],
      connectionId: "codex-local",
      workspace,
    };
    const existing = await service.workflows.create({
      goal: "体验回归计划",
      acceptance: ["总结果"],
      coordinatorId: "codex-local",
      threadId: "fixture",
      nodes: [base],
      autoReview: false,
    });
    existing.goal = "已保存的人工协作";
    existing.running = true;
    existing.status = "working";
    service.store.saveWorkflow(existing);
    const question = await service.create({
      goal: "收件箱待办 fixture",
      plan: ["模拟"],
      acceptance: ["核对"],
      mode: "demo",
      maxRounds: 3,
    });
    await service.action(question.id, "dispatch");
    service.close();
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
    try {
      app = await electron.launch(options);
      let page = await app.firstWindow();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByRole("button", { name: /协作计划/ }).click();
      await page
        .getByRole("button", { name: "暂停新工作", exact: true })
        .click();
      await page.getByText("已暂停新工作", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "继续协作 / 重试自动流程", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "前往对应任务处理", exact: true })
        .click();
      await page.getByLabel("答复并继续原会话").waitFor();
      await page.evaluate(
        ({ workspace, base }) => {
          const set = (key, value) =>
            localStorage.setItem(
              "ai-cooperation:draft:v1:" + key,
              JSON.stringify(value),
            );
          set("workflow.goal", "体验回归计划");
          set("workflow.workspace", workspace);
          set("workflow.coordinator", "codex-local");
          set("workflow.auto", false);
          set("workflow.plan", {
            goal: "体验回归计划",
            coordinatorId: "codex-local",
            threadId: "fixture",
            nodes: [base],
            acceptance: ["总结果"],
          });
        },
        { workspace, base },
      );
      await page.reload();
      await page.getByRole("button", { name: /协作计划/ }).click();
      await page
        .getByLabel("A 步骤", { exact: true })
        .fill("读取输入\n验证输入");
      await page
        .getByRole("button", { name: "添加子任务", exact: true })
        .click();
      await page.getByLabel("T1 子目标", { exact: true }).fill("第二项");
      await page.getByLabel("T1 步骤", { exact: true }).fill("使用前置结果");
      await page.getByLabel("T1 验收", { exact: true }).fill("集成可检查");
      await page.getByLabel("T1 前置依赖", { exact: true }).selectOption(["A"]);
      await page.getByLabel("A 前置依赖", { exact: true }).selectOption(["T1"]);
      await page
        .getByRole("button", { name: "检查开工条件", exact: true })
        .click();
      await page.getByText(/子任务依赖形成循环/).waitFor();
      await page.getByLabel("A 前置依赖", { exact: true }).selectOption([]);
      await page
        .getByRole("button", { name: "检查开工条件", exact: true })
        .click();
      await page
        .getByText("配置检查通过；模型调用仍需实际任务验证", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: /Agent 连接/ }).click();
      await page.getByRole("button", { name: /协作计划/ }).click();
      assert.equal(
        await page.getByLabel("A 步骤", { exact: true }).inputValue(),
        "读取输入\n验证输入",
      );
      await app.close();
      app = await electron.launch(options);
      page = await app.firstWindow();
      await page.getByRole("button", { name: /协作计划/ }).click();
      assert.equal(
        await page.getByLabel("T1 子目标", { exact: true }).inputValue(),
        "第二项",
      );
      assert.equal(
        await page.getByLabel("协作总体目标").inputValue(),
        "体验回归计划",
      );
      await mkdir("outputs", { recursive: true });
      await page.screenshot({
        path: path.resolve("outputs/workflow-editor-v050.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "保存协作计划", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "体验回归计划", exact: true })
        .waitFor();
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      const saved = snapshot.workflows.find((w) => w.goal === "体验回归计划");
      assert.equal(saved.nodes.length, 2);
      assert.deepEqual(saved.nodes[1].dependsOn, ["A"]);
      assert.equal(saved.running, false);
      await page
        .getByRole("button", { name: "前往对应任务处理", exact: true })
        .click();
      await page.getByLabel("答复并继续原会话").waitFor();
      await app.evaluate(
        ({ BrowserWindow }, id) =>
          BrowserWindow.getAllWindows()[0].webContents.send(
            "cooperation:navigate",
            { page: "workflows", id },
          ),
        existing.id,
      );
      await page
        .getByRole("heading", { name: "制定新的协作计划", exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
    } finally {
      if (app) await app.close();
    }
  },
);
