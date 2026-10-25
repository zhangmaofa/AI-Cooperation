import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopService } from "../backend/service.mjs";

test("desktop task uses real SQLite, keeps the same demo context on revision, and survives restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-service-test-"));
  let service = new DesktopService({ root });
  let task = await service.create({
    goal: "Test scoped delivery",
    plan: ["Write", "Verify"],
    acceptance: ["Proof exists"],
    mode: "demo",
    maxRounds: 2,
  });
  task = await service.action(task.id, "dispatch");
  assert.equal(task.status, "needs_input");
  const contextId = task.contextId;
  task = await service.action(task.id, "answer", {
    text: "Verify the scoped result.",
  });
  assert.equal(task.status, "pending_review");
  task = await service.action(task.id, "review", {
    decision: "revise",
    feedback: "Add missing evidence",
  });
  assert.equal(task.status, "revision_ready");
  task = await service.action(task.id, "dispatch");
  assert.equal(task.contextId, contextId);
  task = await service.action(task.id, "review", {
    decision: "accept",
    feedback: "Simulation checked",
    evidence: [
      { criterionId: "C1", passed: true, reference: "simulated evidence only" },
    ],
  });
  assert.equal(task.status, "accepted");
  const signature = service.store.db.prepare("PRAGMA journal_mode").get();
  assert.equal(signature.journal_mode, "wal");
  service.close();
  service = new DesktopService({ root });
  assert.equal(service.snapshot().tasks[0].status, "accepted");
  assert.equal(service.snapshot().tasks[0].contextId, contextId);
  service.close();
});

test("desktop connection snapshots never expose credential references; invalid endpoints fail before saving", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-connections-test-"));
  const service = new DesktopService({ root });
  await assert.rejects(
    service.handle("connection.save", {
      name: "bad",
      kind: "a2a",
      endpoint: "http://remote.example/agent",
    }),
    /HTTPS/,
  );
  await service.handle("connection.save", {
    name: "A2A",
    kind: "a2a",
    endpoint: "http://127.0.0.1:43120/a2a/v0.3/agents/test",
    tokenRef: "private-vault-ref",
  });
  const snapshot = service.snapshot();
  assert.equal(JSON.stringify(snapshot).includes("private-vault-ref"), false);
  assert.equal(
    snapshot.connections.find((c) => c.name === "A2A").hasToken,
    true,
  );
  await assert.rejects(
    service.create({
      goal: "scope",
      plan: ["step"],
      acceptance: ["check"],
      mode: "real",
      maxRounds: 5,
      connectionId: snapshot.connections[0].id,
    }),
    /A2A/,
  );
  service.close();
});

test("restart retains uncertain delivery instead of sending again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-recovery-test-"));
  let service = new DesktopService({ root });
  const task = await service.create({
    goal: "scope",
    plan: ["step"],
    acceptance: ["check"],
    mode: "demo",
    maxRounds: 5,
  });
  task.status = "sending";
  task.pending = { messageId: "test-existing-message" };
  service.store.saveTask(task);
  service.close();
  service = new DesktopService({ root });
  const recovered = service.snapshot().tasks[0];
  assert.equal(recovered.status, "delivery_unknown");
  assert.equal(recovered.pending.messageId, "test-existing-message");
  await assert.rejects(service.action(task.id, "dispatch"), /delivery_unknown/);
  service.close();
});
