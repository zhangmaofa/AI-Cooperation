import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../backend/acp.mjs";
import { spawn } from "node:child_process";
const connection = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/acp-server.mjs", import.meta.url))],
  cwd: process.cwd(),
};
test("ACP v1 discovers capabilities, continues native session and declines permissions", async () => {
  const client = new AcpClient(connection);
  try {
    assert.equal((await client.inspect()).capabilities.loadSession, true);
    const id = await client.openThread();
    assert.equal(id, "native-acp-session");
    const first = await client.run("implement", id, { threadPrepared: true });
    assert.match(first.text, /ACP fixture/);
    const second = await client.run("revise", id);
    assert.equal(second.threadId, id);
    const permission = await client.run("permission", id);
    assert.equal(permission.needsUser, true);
  } finally {
    client.close();
  }
});
test("ACP without loadSession never replaces the original conversation on restart", async () => {
  const client = new AcpClient(connection, {
    spawnImpl: (command, args, options) =>
      spawn(command, args, {
        ...options,
        env: { ...process.env, AICO_ACP_NO_LOAD: "1" },
      }),
  });
  try {
    await client.inspect();
    await assert.rejects(
      client.openThread("original-unloaded-session"),
      /无法恢复原会话/,
    );
  } finally {
    client.close();
  }
});
