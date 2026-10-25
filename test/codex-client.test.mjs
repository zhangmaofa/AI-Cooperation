import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexClient, parseModelJSON } from "../backend/codex.mjs";

test("Codex app-server adapter discovers models, parses completion and resumes original thread", async () => {
  const client = new CodexClient(
    { command: "fixture" },
    {
      spawnImpl: () =>
        spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("./fixtures/codex-server.mjs", import.meta.url),
            ),
          ],
          { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        ),
    },
  );
  try {
    assert.equal((await client.inspect()).models[0].id, "test-model");
    const result = await client.run("Plan the test");
    assert.equal(result.threadId, "fixture-thread");
    assert.deepEqual(parseModelJSON(result.text).plan, ["Read"]);
    const continued = await client.run("Review the test", result.threadId);
    assert.equal(continued.threadId, result.threadId);
    assert.throws(() => parseModelJSON("not JSON"), /结构化/);
  } finally {
    client.close();
  }
});
