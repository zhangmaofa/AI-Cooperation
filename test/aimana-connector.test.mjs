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
  const ready = {
    agentId: "enabled",
    enabled: true,
    updatedAtMs: 123,
    projectPath: "C:/fixture",
    model: "fixture-model",
    hasToken: true,
  };
  let configs = [
    ready,
    { agentId: "disabled", enabled: false },
    {
      agentId: "unsaved",
      enabled: true,
      updatedAtMs: 0,
      model: "",
      projectPath: null,
      hasToken: false,
    },
  ];
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
              agents: configs,
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
      setAttribute(name, value) {
        this[name] = value;
      },
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
  assert.match(
    root.children.find((e) => e.tag === "ul").children[0].textContent,
    /Workspace 尚未保存/,
  );
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
  // Config may be changed in the native editor after refreshing our selector.
  // Recheck every prerequisite before starting services or revealing credentials.
  for (const [patch, reason] of [
    [{ enabled: false }, "Workspace 已关闭"],
    [{ updatedAtMs: 0 }, "Workspace 尚未保存"],
    [{ projectPath: null }, "未选择工作目录"],
    [{ model: " " }, "未选择模型"],
    [{ hasToken: false }, "未生成本机连接凭据"],
  ]) {
    configs = [ready];
    await root.children
      .find((e) => e.textContent === "读取已启用的 Agent")
      .onclick();
    root.children.find((e) => e.tag === "input").value =
      "12345." + "c".repeat(36);
    configs = [{ ...ready, ...patch }];
    const count = calls.length;
    await root.children
      .find((e) => e.textContent === "配对选中 Agent")
      .onclick();
    assert.deepEqual(calls.slice(count), ["a2a:config:get"]);
    assert.equal(posts, 2);
    assert.match(
      root.children.find((e) => e.role === "status").textContent,
      new RegExp(reason),
    );
    await root.children
      .find((e) => e.textContent === "读取已启用的 Agent")
      .onclick();
    assert.equal(
      root.children.find((e) => e.tag === "select").options.length,
      0,
    );
  }
  main.module.exports.stop();
  renderer.module.exports.stop();
});
