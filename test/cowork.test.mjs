import test from "node:test";
import assert from "node:assert/strict";
import { CoworkClient, coworkEndpoint } from "../src/cowork.mjs";

test("Cowork endpoint is loopback-only and sends connection credential solely as a header", async () => {
  for (const value of [
    "http://localhost:1234/cowork",
    "http://127.0.0.1:1234/cowork?token=x",
    "https://example.com/cowork",
    "http://user:x@127.0.0.1:1234/cowork",
    "http://127.0.0.1:99999/cowork",
    "http://127.0.0.1:1234/other",
  ])
    assert.throws(() => coworkEndpoint(value));
  const profile = {
    endpoint: "http://127.0.0.1:1234/cowork",
    agentId: "writer",
    model: "small",
    cwd: "C:/fixture",
  };
  let mismatch = false;
  const client = new CoworkClient(profile, {
    tokenProvider: async () => "fixture-secret",
    fetchImpl: async (url, options) => {
      assert.equal(url, profile.endpoint);
      assert.equal(options.headers.Authorization, "Bearer fixture-secret");
      assert.equal(options.body.includes("fixture-secret"), false);
      assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body);
      assert.equal(body.data.profile.agentId, "writer");
      assert.equal(body.data.profile.model, "small");
      assert.equal(body.data.profile.permissionMode, "ask");
      return {
        ok: true,
        json: async () => ({
          id: mismatch ? "wrong" : body.id,
          result: {
            kind: "task",
            id: "run",
            contextId: "ctx",
            status: { state: "working" },
          },
        }),
      };
    },
  });
  const result = await client.send({ text: "fixture", messageId: "message" });
  assert.equal(result.id, "run");
  mismatch = true;
  await assert.rejects(
    client.send({ text: "fixture", messageId: "message2" }),
    /响应不匹配/,
  );
});
