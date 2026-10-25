import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { _electron as electron } from "@playwright/test";

const runtime = path.join(
  process.env.LOCALAPPDATA || "",
  ".aimana-plusplus",
  "runtime",
);
test(
  "installed AIMana++ sandbox runtime loads both connector processes and pairs through real Electron IPC",
  { timeout: 60000, skip: !existsSync(path.join(runtime, "main.cjs")) },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aico-real-runtime-"));
    const tempRuntime = path.join(root, "runtime"),
      tweak = path.join(root, "tweaks", "com.zhangmaofa.ai-cooperation");
    await mkdir(tempRuntime, { recursive: true });
    await mkdir(tweak, { recursive: true });
    for (const name of ["main.cjs", "preload.cjs"])
      await copyFile(path.join(runtime, name), path.join(tempRuntime, name));
    for (const name of ["index.js", "manifest.json"])
      await copyFile(
        path.resolve("connectors/aimana", name),
        path.join(tweak, name),
      );
    const currentSource = await readFile(path.join(tweak, "index.js"), "utf8");
    await writeFile(
      path.join(tweak, "index.js"),
      currentSource.replaceAll("0.3.2", "0.3.1-cache-test"),
    );
    let received = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const payload = JSON.parse(body);
      assert.equal(payload.agentId, "fixture-agent");
      assert.equal(payload.token, "runtime-fixture-only");
      received++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let app;
    try {
      app = await electron.launch({
        args: [path.resolve("test/fixtures/aimana-runtime.cjs")],
        env: {
          ...process.env,
          AIMANAPP_USER_ROOT: root,
          AIMANAPP_RUNTIME: tempRuntime,
        },
      });
      const page = await app.firstWindow();
      await page.locator("#aimanapp-panel").waitFor({ state: "attached" });
      await page.keyboard.press("Control+Alt+u");
      await page
        .getByText("连接器 v0.3.1-cache-test · 主进程 / 面板版本一致", {
          exact: true,
        })
        .waitFor();
      await page
        .getByRole("button", { name: "读取已启用的 Agent", exact: true })
        .click();
      await page
        .getByLabel("AI-Cooperation 配对码", { exact: true })
        .fill(`${server.address().port}.${"a".repeat(36)}`);
      await page
        .getByRole("button", { name: "配对选中 Agent", exact: true })
        .click();
      await page
        .getByText("配对成功，可以回 AI-Cooperation 派发任务。", {
          exact: true,
        })
        .waitFor();
      assert.equal(received, 1);
      await writeFile(path.join(tweak, "index.js"), currentSource);
      await page.getByRole("button", { name: "重载", exact: true }).click();
      await page
        .getByText("连接器 v0.3.2 · 主进程 / 面板版本一致", { exact: true })
        .waitFor();
      const logs = await readFile(path.join(root, "log", "main.log"), "utf8");
      assert.match(logs, /connector 0\.3\.2 main loaded/);
      assert.match(logs, /connector 0\.3\.2 renderer loaded/);
      assert.equal(logs.includes("runtime-fixture-only"), false);
      assert.match(logs, /native-service-status stopped/);
      assert.match(logs, /main paired ok/);
    } finally {
      if (app) await app.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
