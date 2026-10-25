import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import vm from "node:vm";
import { extractFile } from "@electron/asar";

const archive = "C:/Program Files/mt-aimana/resources/app.orig.asar";
test(
  "installed AIMana unsaved enabled defaults cannot start its persisted-config server",
  { skip: !existsSync(archive) },
  async () => {
    // Exercise the installed implementation itself with isolated configuration.
    // No account database, credentials, network listener or app process is used.
    const source = extractFile(archive, "out\\main\\index.js").toString();
    const methodStart = source.indexOf(
      "  getAgentConfig(agentId) {",
      source.indexOf("class A2AConfigRepository"),
    );
    const methodEnd = source.indexOf("\n  hasAgentConfig(", methodStart);
    const nativeDefault = vm.runInNewContext(
      `({${source.slice(methodStart, methodEnd)}})`,
      {
        requireAgentId$1: (value) => value,
        A2A_DEFAULT_PERMISSION: "ask",
        A2A_DEFAULT_RUNTIME_MODE: "managed_sdk",
      },
    );
    nativeDefault.database = { prepare: () => ({ get: () => undefined }) };
    const unsaved = nativeDefault.getAgentConfig("fixture-agent");
    assert.equal(unsaved.enabled, true);
    assert.equal(unsaved.updatedAtMs, 0);
    assert.equal(unsaved.model, "");
    assert.equal(unsaved.tokenId, null);

    const start = source.indexOf("class InternalServerConfigSource");
    const end = source.indexOf("class LanServerConfigSource", start);
    const serverStart = source.indexOf("class A2AServer {");
    const serverEnd = source.indexOf("let defaultServer = null;", serverStart);
    const { InternalServerConfigSource, A2AServer } = vm.runInNewContext(
      `${source.slice(start, end)}\n${source.slice(serverStart, serverEnd)}\n({InternalServerConfigSource, A2AServer})`,
      { A2A_INTERNAL_PORT: 43119, requirePrivateIPv4: (value) => value },
    );
    const config = new InternalServerConfigSource({
      listAgentConfigs: () => [{ enabled: false }],
    });
    const server = new A2AServer({
      config,
      createHttpServer: () => {
        throw new Error("must not listen");
      },
      availableAddresses: () => ["127.0.0.1"],
      createApp: () => {
        throw new Error("must not create app");
      },
    });
    assert.equal((await server.start()).phase, "stopped");
  },
);
