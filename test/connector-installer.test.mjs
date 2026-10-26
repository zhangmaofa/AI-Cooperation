import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import installer from "../desktop/connector.cjs";
test("older bundled connector never replaces a newer installed build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-no-downgrade-"));
  const source = path.join(root, "connectors", "aimana"),
    runtime = path.join(root, "framework"),
    destination = path.join(runtime, "tweaks", "com.zhangmaofa.ai-cooperation");
  await mkdir(source, { recursive: true });
  await mkdir(path.join(runtime, "runtime"), { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(source, "manifest.json"),
    JSON.stringify({ id: "com.zhangmaofa.ai-cooperation", version: "0.3.1" }),
  );
  await writeFile(path.join(source, "index.js"), "old bundled code");
  await writeFile(path.join(source, "gateway.cjs"), "gateway fixture");
  await writeFile(
    path.join(destination, "manifest.json"),
    JSON.stringify({ version: "0.3.2" }),
  );
  await writeFile(path.join(destination, "index.js"), "new installed code");
  assert.equal(installer.installConnector(root, runtime).updated, false);
  assert.equal(
    await readFile(path.join(destination, "index.js"), "utf8"),
    "new installed code",
  );
  await writeFile(
    path.join(source, "manifest.json"),
    JSON.stringify({ id: "com.zhangmaofa.ai-cooperation", version: "0.3.3" }),
  );
  await writeFile(path.join(source, "index.js"), "new update");
  assert.equal(installer.installConnector(root, runtime).updated, true);
  assert.equal(
    await readFile(path.join(destination, "index.js"), "utf8"),
    "new update",
  );
});
