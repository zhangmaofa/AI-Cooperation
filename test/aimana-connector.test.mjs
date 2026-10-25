import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("AIMana connector reads native token only after explicit pairing and sends only to a loopback endpoint", async () => {
  const source = await readFile(
    new URL("../connectors/aimana/index.js", import.meta.url),
    "utf8",
  );
  const handlers = new Map();
  const calls = [];
  let posts = 0;
  let running = false;
  const native = {
    ipcMain: { removeHandler() {} },
    ipcRenderer: {
      async invoke(method) {
        calls.push(method);
        if (method === "a2a:server:status")
          return { phase: running ? "running" : "stopped" };
        if (method === "a2a:server:retry") {
          running = true;
          return { phase: "running" };
        }
        return method === "a2a:config:get"
          ? {
              agents: [
                { agentId: "enabled", enabled: true },
                { agentId: "disabled", enabled: false },
              ],
            }
          : { token: "fixture-native-secret" };
      },
    },
  };
  const main = {
    module: { exports: {} },
    require: () => native,
    AbortSignal,
    fetch: async (url, options) => {
      posts++;
      assert.equal(url, "http://127.0.0.1:12345/pair");
      const body = JSON.parse(options.body);
      assert.equal(body.agentId, "enabled");
      assert.equal(body.token, "fixture-native-secret");
      return { ok: true };
    },
  };
  vm.runInNewContext(source, main);
  main.module.exports.start({
    process: "main",
    manifest: { id: "com.zhangmaofa.ai-cooperation" },
    ipc: { handle: (name, callback) => handlers.set(name, callback) },
  });
  function element(tag) {
    return {
      tag,
      value: "",
      children: [],
      options: [],
      setAttribute() {},
      append(...items) {
        this.children.push(...items);
        if (tag === "select") {
          this.options.push(...items);
          this.value ||= items[0]?.value;
        }
      },
      replaceChildren() {
        this.children = [];
        this.options = [];
        this.value = "";
      },
    };
  }
  const root = element("root");
  const renderer = {
    module: { exports: {} },
    require: () => native,
    document: { createElement: element },
  };
  vm.runInNewContext(source, renderer);
  renderer.module.exports.start({
    process: "renderer",
    settings: {
      register(section) {
        section.render(root);
        return { unregister() {} };
      },
    },
    ipc: { invoke: async (channel, payload) => handlers.get(channel)(payload) },
  });
  assert.deepEqual(calls, []);
  await root.children
    .find((e) => e.textContent === "读取已启用的 Agent")
    .onclick();
  assert.deepEqual(calls, ["a2a:config:get"]);
  assert.equal(root.children.find((e) => e.tag === "select").options.length, 1);
  root.children.find((e) => e.tag === "input").value =
    "12345." + "a".repeat(36);
  await root.children.find((e) => e.textContent === "配对选中 Agent").onclick();
  assert.equal(posts, 1);
  assert.deepEqual(calls, [
    "a2a:config:get",
    "a2a:config:get",
    "a2a:server:status",
    "a2a:server:retry",
    "a2a:token:reveal",
  ]);
  assert.equal(root.children.find((e) => e.tag === "input").value, "");
  root.children.find((e) => e.tag === "input").value =
    "12345." + "b".repeat(36);
  await root.children.find((e) => e.textContent === "配对选中 Agent").onclick();
  assert.equal(posts, 2);
  assert.equal(
    calls.filter((method) => method === "a2a:server:retry").length,
    1,
    "already-running native service must not be restarted",
  );
  main.module.exports.stop();
  renderer.module.exports.stop();
});
