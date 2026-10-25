import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopService } from "../backend/service.mjs";
import { CodexClient } from "../backend/codex.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("first worker turn starts on the prepared live thread without attempting premature rollout resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-codex-protocol-"));
  const service = new DesktopService({
    root,
    clientFactory: (connection, { role }) =>
      new CodexClient(connection, {
        role,
        spawnImpl: () =>
          spawn(
            process.execPath,
            [
              fileURLToPath(
                new URL("./fixtures/codex-server.mjs", import.meta.url),
              ),
            ],
            {
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
              env: { ...process.env, AICO_FIXTURE_PROFILE: role },
            },
          ),
      }),
  });
  try {
    let task = await service.create({
      goal: "Scoped protocol fixture",
      plan: ["Execute"],
      acceptance: ["Report"],
      mode: "real",
      connectionId: "codex-local",
      workspace: root,
      maxRounds: 2,
    });
    task = await service.action(task.id, "dispatch");
    for (let i = 0; i < 100 && task.status === "working"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = await service.action(task.id, "poll");
    }
    assert.equal(task.status, "pending_review");
    assert.equal(task.result.text, "fixture execution");
  } finally {
    service.close();
  }
});

test("Codex can be coordinator and worker: independent profiles, question, original-session rework and automatic review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-dual-role-"));
  const calls = [];
  const clientRoles = [];
  let executions = 0;
  let reviews = 0;
  let sessionCounter = 0;
  const factory = (connection, { role }) => {
    clientRoles.push(role);
    return {
      async openThread(id) {
        return id || `${role}-thread-${++sessionCounter}`;
      },
      async run(prompt, id, options = {}) {
        const threadId = id || `${role}-thread-${++sessionCounter}`;
        calls.push({
          role,
          threadId,
          cwd: connection.cwd,
          model: connection.model,
        });
        options.onStarted?.({ turnId: `turn-${calls.length}` });
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (role === "coordinator" && !id)
          return {
            threadId,
            text: JSON.stringify({
              plan: ["Write", "Verify"],
              acceptance: ["Actual report exists"],
            }),
          };
        if (role === "coordinator") {
          reviews++;
          return {
            threadId,
            text: JSON.stringify(
              reviews === 1
                ? {
                    decision: "revise",
                    feedback: "Add missing evidence",
                    evidence: [],
                  }
                : {
                    decision: "accept",
                    feedback: "Independently checked fixture result",
                    evidence: [
                      {
                        criterionId: "C1",
                        passed: true,
                        reference:
                          "fixture verification, not real model evidence",
                      },
                    ],
                  },
            ),
          };
        }
        executions++;
        return {
          threadId,
          text: JSON.stringify(
            executions === 1
              ? { status: "needs_input", question: "Which scoped result?" }
              : { status: "completed", summary: "Fixture output completed" },
          ),
        };
      },
      close() {},
    };
  };
  const service = new DesktopService({ root, clientFactory: factory });
  try {
    const main = service.store.connection("codex-local");
    main.model = "strong-fixture";
    service.store.saveConnection(main);
    const worker = await service.handle("connection.save", {
      name: "Worker",
      kind: "codex",
      command: "fixture",
      model: "cheap-fixture",
      cwd: root,
    });
    const plan = await service.analyze({
      goal: "Scoped fixture work",
      coordinatorId: main.id,
    });
    let task = await service.create({
      ...plan,
      goal: "Scoped fixture work",
      mode: "real",
      connectionId: worker.id,
      workspace: root,
      maxRounds: 3,
      autoReview: true,
    });
    assert.equal(task.executor.type, "codex");
    task = await service.action(task.id, "dispatch");
    const contextId = task.contextId;
    assert.notEqual(contextId, task.ownerThreadId);
    async function settle() {
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        task = await service.action(task.id, "poll");
        if (task.status !== "working") return;
      }
      throw new Error("Fixture did not settle");
    }
    await settle();
    assert.equal(task.status, "needs_input");
    await service.action(task.id, "answer", {
      text: "Keep the scoped result.",
    });
    await settle();
    assert.equal(task.status, "accepted");
    assert.equal(task.rounds, 2);
    assert.equal(task.contextId, contextId);
    assert.equal(task.reviews.length, 2);
    assert.equal(service.store.executions().length, 3);
    assert.equal(
      new Set(calls.filter((c) => c.role === "executor").map((c) => c.threadId))
        .size,
      1,
    );
    assert.ok(
      calls
        .filter((c) => c.role === "executor")
        .every((c) => c.model === "cheap-fixture" && c.cwd === root),
    );
    assert.ok(
      calls
        .filter((c) => c.role === "coordinator")
        .every((c) => c.model === "strong-fixture"),
    );
    assert.equal(
      clientRoles.filter((role) => role === "coordinator").length,
      1,
      "review must reuse the original coordinator writer",
    );
  } finally {
    service.close();
  }
});

test("Codex requires a concrete working folder and retains the binding when an in-progress worker is interrupted by restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-codex-recovery-"));
  let service = new DesktopService({
    root,
    clientFactory: () => ({
      openThread: async () => "retained-worker-session",
      run: () => new Promise(() => {}),
      close() {},
    }),
  });
  await assert.rejects(
    service.create({
      goal: "Scope",
      plan: ["Write"],
      acceptance: ["File exists"],
      mode: "real",
      connectionId: "codex-local",
      maxRounds: 2,
    }),
    /工作目录/,
  );
  let task = await service.create({
    goal: "Scope",
    plan: ["Write"],
    acceptance: ["File exists"],
    mode: "real",
    connectionId: "codex-local",
    workspace: root,
    maxRounds: 2,
  });
  task = await service.action(task.id, "dispatch");
  assert.equal(task.status, "working");
  service.close();
  service = new DesktopService({ root });
  try {
    const recovered = service.store.task(task.id);
    assert.equal(recovered.status, "delivery_unknown");
    assert.equal(recovered.contextId, "retained-worker-session");
    assert.equal(
      service.store.execution(recovered.remoteTaskId).state,
      "unknown",
    );
    await assert.rejects(
      service.action(task.id, "dispatch"),
      /delivery_unknown/,
    );
  } finally {
    service.close();
  }
});
