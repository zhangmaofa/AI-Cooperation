import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

test(
  "desktop real-transport fixture: configure A2A token, test card, dispatch and review without leaking the token",
  { timeout: 60000 },
  async () => {
    const requests = [];
    const token = "aico-test-fixture-only";
    const server = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(
          JSON.stringify({ name: "HTTP Fixture Agent", capabilities: {} }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      requests.push(message);
      const needsInput = !message.params.message?.contextId;
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            kind: "task",
            id: "http-task",
            contextId: "http-context",
            status: {
              state: needsInput ? "input-required" : "completed",
              message: {
                parts: [
                  {
                    kind: "text",
                    text: needsInput
                      ? "HTTP fixture asks for scope."
                      : "HTTP fixture delivery; not a real model result.",
                  },
                ],
              },
            },
          },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/a2a/v0.3/agents/fixture`;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "aico-a2a-ui-test-"));
    let app;
    try {
      app = await electron.launch({
        args: ["."],
        cwd: process.cwd(),
        env: {
          ...process.env,
          AICO_TEST: "1",
          AICO_DATA_DIR: dataDir,
          AICO_NODE_EXEC: process.execPath,
        },
      });
      const page = await app.firstWindow();
      await page.getByRole("button", { name: /Agent 连接/ }).click();
      await page.getByRole("button", { name: "添加连接" }).click();
      await page.getByLabel("连接名称").fill("HTTP 测试执行器");
      await page.getByLabel("A2A 接口地址").fill(endpoint);
      await page.getByLabel("访问 Token").fill(token);
      await page.getByRole("button", { name: "保存连接" }).click();
      const card = page
        .locator(".agent-card")
        .filter({
          has: page.getByRole("heading", { name: "HTTP 测试执行器" }),
        });
      await card.getByRole("button", { name: "测试连接" }).click();
      await card.getByText("连接可用", { exact: true }).waitFor();
      await page.getByRole("button", { name: /任务工作台/ }).click();
      await page.getByRole("button", { name: "新建协作任务" }).click();
      await page
        .getByRole("button", { name: "真实 Agent", exact: true })
        .click();
      await page.getByLabel("任务目标").fill("HTTP fixture test only");
      await page
        .getByLabel("执行计划", { exact: true })
        .fill("Return fixture report");
      await page
        .getByLabel("验收标准", { exact: true })
        .fill("The fixture response is received");
      await page.getByRole("button", { name: "创建任务", exact: true }).click();
      await page.getByRole("button", { name: "开始执行", exact: true }).click();
      await page.getByText("Agent 的疑问", { exact: true }).waitFor();
      await page.getByLabel("答复并继续原会话").fill("Fixture scope only.");
      await page.getByRole("button", { name: "发送答复" }).click();
      await page.getByText("审核这次交付", { exact: true }).waitFor();
      await page
        .getByLabel("审核意见 / 修改要求")
        .fill("HTTP transport fixture independently checked.");
      await page
        .getByLabel("C1 验收证据")
        .fill("Received fixture response over localhost HTTP.");
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      await page.getByText("任务已验收", { exact: true }).waitFor();
      const snapshot = await page.evaluate(() =>
        window.cooperation.request("snapshot"),
      );
      assert.equal(snapshot.tasks[0].mode, "real");
      assert.equal(snapshot.tasks[0].contextId, "http-context");
      assert.equal(snapshot.tasks[0].status, "accepted");
      assert.equal(JSON.stringify(snapshot).includes(token), false);
      assert.equal(
        (
          await readFile(path.join(dataDir, "credentials.json"), "utf8")
        ).includes(token),
        false,
      );
      assert.equal(requests[1].params.message.taskId, "http-task");
      assert.equal(requests[1].params.message.contextId, "http-context");
    } finally {
      if (app) await app.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
