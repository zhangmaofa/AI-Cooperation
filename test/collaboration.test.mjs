import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DesktopService } from "../backend/service.mjs";
import { validateGraph } from "../backend/workflows.mjs";

async function setup(factory) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aico-collaboration-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const service = new DesktopService({
    root: path.join(root, "data"),
    clientFactory: factory,
  });
  return { service, root, workspace };
}
const complete = (summary) => ({
  text: JSON.stringify({ status: "completed", summary }),
});
function immediate(connection) {
  return {
    connection,
    openThread: async (id) => id || `thread-${crypto.randomUUID()}`,
    run: async () => complete("Protocol fixture; no real model"),
    close() {},
  };
}
async function create(service, workspace, extra = {}) {
  return service.create({
    goal: "Scoped fixture",
    plan: ["Implement"],
    acceptance: ["Artifact"],
    mode: "real",
    connectionId: "codex-local",
    workspace,
    maxRounds: 5,
    ...extra,
  });
}
async function settle(service, task) {
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    task = await service.action(task.id, "poll");
    if (task.status !== "working") return task;
  }
  throw new Error("Fixture failed to settle");
}
const accept = {
  decision: "accept",
  feedback: "Independently verified fixture",
  evidence: [
    {
      criterionId: "C1",
      passed: true,
      reference: "Fixture artifact inspection",
    },
  ],
};

test("overall verification failure returns the original child to rework before any model can accept", async () => {
  let mainCalls = 0;
  const { service, workspace } = await setup((connection, { role }) => ({
    ...immediate(connection),
    async run() {
      if (role === "coordinator") {
        mainCalls++;
        return {
          text: JSON.stringify({
            decision: "accept",
            feedback: "Actual fixture inspected",
            evidence: ["result inspected"],
            reviseNodes: [],
          }),
        };
      }
      await writeFile(path.join(connection.cwd, "result.txt"), "pass");
      return complete("fixture output");
    },
  }));
  try {
    service.store.setSetting("plan:main", {
      goal: "Overall fixture",
      coordinatorId: "codex-local",
    });
    const workflow = await service.workflows.create({
      goal: "Overall fixture",
      acceptance: ["Artifact"],
      coordinatorId: "codex-local",
      threadId: "main",
      autoReview: false,
      nodes: [
        {
          id: "A",
          goal: "Scoped child",
          plan: ["Write"],
          acceptance: ["Artifact"],
          connectionId: "codex-local",
          workspace,
          dependsOn: [],
          contract: {
            verification: [
              {
                command: process.execPath,
                args: [
                  "-e",
                  "if(require('node:fs').readFileSync('result.txt','utf8')!=='pass')process.exit(1)",
                ],
              },
            ],
          },
        },
      ],
    });
    service.workflows.start(workflow.id);
    let task = await settle(
      service,
      await service.action(workflow.taskIds[0], "dispatch"),
    );
    await service.action(task.id, "review", accept);
    const originalSession = task.contextId;
    await writeFile(
      path.join(workspace, "result.txt"),
      "integration regression",
    );
    const reviewed = await service.workflows.review(workflow.id);
    assert.equal(reviewed.status, "working");
    assert.equal(mainCalls, 0);
    task = service.store.task(task.id);
    assert.equal(task.status, "queued");
    assert.equal(task.contextId, originalSession);
    assert.match(task.reviews.at(-1).feedback, /整体集成验证失败/);
  } finally {
    service.close();
  }
});

test("overall review locks its workspaces and refuses artifacts changed during review", async () => {
  let startReview;
  const entered = new Promise((resolve) => {
    startReview = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { service, workspace } = await setup((connection, { role }) => ({
    ...immediate(connection),
    async run() {
      if (role === "coordinator") {
        startReview();
        await gate;
        await writeFile(
          path.join(workspace, "unexpected.txt"),
          "simulated external write",
        );
        return {
          text: JSON.stringify({
            decision: "accept",
            feedback: "Model proposes acceptance",
            evidence: ["fixture evidence"],
            reviseNodes: [],
          }),
        };
      }
      return complete("fixture");
    },
  }));
  try {
    service.store.setSetting("plan:main", {
      goal: "Review lock fixture",
      coordinatorId: "codex-local",
    });
    const workflow = await service.workflows.create({
      goal: "Review lock fixture",
      acceptance: ["Artifact"],
      coordinatorId: "codex-local",
      threadId: "main",
      autoReview: false,
      nodes: [
        {
          id: "A",
          goal: "Child",
          plan: ["Write"],
          acceptance: ["Artifact"],
          connectionId: "codex-local",
          workspace,
          dependsOn: [],
        },
      ],
    });
    service.workflows.start(workflow.id);
    const child = await settle(
      service,
      await service.action(workflow.taskIds[0], "dispatch"),
    );
    await service.action(child.id, "review", accept);
    const review = service.workflows.review(workflow.id);
    await entered;
    const competitor = await create(service, workspace);
    const queued = await service.action(competitor.id, "dispatch");
    assert.equal(queued.status, "queued");
    assert.match(queued.queueReason, /总体审核/);
    release();
    await assert.rejects(review, /产物发生变化/);
    assert.equal(service.workflows.get(workflow.id).status, "needs_attention");
  } finally {
    release?.();
    service.close();
  }
});

test("optional Git worktree keeps worker modifications out of the original checkout", async () => {
  const run = promisify(execFile);
  const { service, workspace } = await setup((connection) => ({
    ...immediate(connection),
    async run() {
      await writeFile(path.join(connection.cwd, "result.txt"), "isolated");
      return complete("Independent file created");
    },
  }));
  try {
    await run("git", ["init", "-q", workspace], { windowsHide: true });
    await writeFile(path.join(workspace, "base.txt"), "base");
    await run("git", ["-C", workspace, "add", "base.txt"], {
      windowsHide: true,
    });
    await run(
      "git",
      [
        "-C",
        workspace,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { windowsHide: true },
    );
    let task = await create(service, workspace, {
      contract: { isolateWorktree: true },
    });
    task = await settle(service, await service.action(task.id, "dispatch"));
    assert.notEqual(task.executor.cwd, workspace);
    assert.equal(
      await readFile(path.join(task.executor.cwd, "result.txt"), "utf8"),
      "isolated",
    );
    await assert.rejects(
      readFile(path.join(workspace, "result.txt")),
      /ENOENT/,
    );
    assert.equal(
      (
        await run("git", ["-C", workspace, "status", "--porcelain"], {
          windowsHide: true,
        })
      ).stdout.trim(),
      "",
    );
    assert.equal(
      (await service.action(task.id, "review", accept)).status,
      "accepted",
    );
  } finally {
    service.close();
  }
});

test("recovery reads the recorded native turn without sending another instruction", async () => {
  let sends = 0;
  const { service, workspace } = await setup((connection) => ({
    ...immediate(connection),
    run: async (_p, _id, options) => {
      sends++;
      options.onStarted({ turnId: "recorded-turn" });
      throw new Error("transport lost");
    },
    readTurn: async (_thread, turn) => {
      assert.equal(turn, "recorded-turn");
      return {
        status: "completed",
        text: JSON.stringify({
          status: "completed",
          summary: "Native confirmed artifact report",
        }),
      };
    },
  }));
  try {
    let task = await settle(
      service,
      await service.action((await create(service, workspace)).id, "dispatch"),
    );
    assert.equal(task.status, "delivery_unknown");
    const session = task.contextId;
    task = await service.action(task.id, "recover");
    assert.equal(task.status, "pending_review");
    assert.equal(task.contextId, session);
    assert.equal(sends, 1);
  } finally {
    service.close();
  }
});

test("scheduler holds overlapping workspace leases through review and admits queued work only after acceptance", async () => {
  const { service, workspace } = await setup(immediate);
  try {
    const nested = path.join(workspace, "nested");
    await mkdir(nested);
    let first = await create(service, workspace),
      second = await create(service, nested);
    first = await service.action(first.id, "dispatch");
    second = await service.action(second.id, "dispatch");
    assert.equal(second.status, "queued");
    assert.match(second.queueReason, /工作区/);
    first = await settle(service, first);
    await service.tick();
    await service.drainBackground();
    assert.equal(service.store.task(second.id).status, "queued");
    await service.action(first.id, "review", accept);
    await service.tick();
    await service.drainBackground();
    assert.equal(service.store.task(second.id).status, "working");
  } finally {
    service.close();
  }
});

test("global concurrency cap applies to independent workspaces, including simultaneous dispatch calls", async () => {
  const { service, root, workspace } = await setup(immediate);
  try {
    await service.handle("scheduler.save", {
      maxConcurrent: 1,
      perConnection: 2,
    });
    const other = path.join(root, "other");
    await mkdir(other);
    const tasks = [
      await create(service, workspace),
      await create(service, other),
    ];
    const dispatched = await Promise.all(
      tasks.map((t) => service.action(t.id, "dispatch")),
    );
    assert.equal(dispatched.filter((t) => t.status === "working").length, 1);
    assert.equal(dispatched.filter((t) => t.status === "queued").length, 1);
  } finally {
    service.close();
  }
});

test("failed independent verification prevents acceptance even with model-like evidence", async () => {
  const { service, workspace } = await setup(immediate);
  try {
    let task = await create(service, workspace, {
      contract: {
        verification: [
          {
            command: process.execPath,
            args: ["-e", "console.log('expected failure');process.exit(2)"],
          },
        ],
      },
    });
    task = await settle(service, await service.action(task.id, "dispatch"));
    assert.equal(task.verifications[0].checks[0].passed, false);
    await assert.rejects(
      service.action(task.id, "review", accept),
      /独立验证未通过/,
    );
    assert.equal(service.store.task(task.id).status, "pending_review");
  } finally {
    service.close();
  }
});

test("scope breaches and changes after verification cannot be accepted; reverify keeps the same round", async () => {
  const { service, workspace } = await setup((connection) => ({
    ...immediate(connection),
    run: async () => {
      await writeFile(path.join(connection.cwd, "outside.txt"), "changed");
      return complete("changed");
    },
  }));
  try {
    let task = await create(service, workspace, {
      contract: { allowedPaths: ["src"] },
    });
    task = await settle(service, await service.action(task.id, "dispatch"));
    assert.deepEqual(task.verifications[0].outside, ["outside.txt"]);
    await assert.rejects(service.action(task.id, "review", accept), /范围外/);
  } finally {
    service.close();
  }
  const next = await setup(immediate);
  try {
    let task = await settle(
      next.service,
      await next.service.action(
        (await create(next.service, next.workspace)).id,
        "dispatch",
      ),
    );
    await writeFile(path.join(next.workspace, "after.txt"), "external change");
    await assert.rejects(
      next.service.action(task.id, "review", accept),
      /工作区已改变/,
    );
    await next.service.action(task.id, "reverify");
    task = await next.service.action(task.id, "review", accept);
    assert.equal(task.status, "accepted");
    assert.equal(task.rounds, 1);
  } finally {
    next.service.close();
  }
});

test("question is persisted once, original coordinator answers, and worker resumes the original session", async () => {
  let work = 0,
    questions = 0;
  const sessions = [];
  const { service, workspace } = await setup((connection, { role }) => ({
    ...immediate(connection),
    async run(prompt, id) {
      if (role === "coordinator" && !id)
        return {
          threadId: "main",
          text: JSON.stringify({
            plan: ["Implement"],
            acceptance: ["Artifact"],
          }),
        };
      if (role === "coordinator") {
        questions++;
        return {
          threadId: id,
          text: JSON.stringify({
            decision: "answer",
            answer: "Use the frozen scope.",
          }),
        };
      }
      sessions.push(id);
      work++;
      return work === 1
        ? {
            text: JSON.stringify({
              status: "needs_input",
              question: "Which already agreed scope?",
            }),
          }
        : complete("done");
    },
  }));
  try {
    const plan = await service.analyze({
      goal: "Scoped fixture",
      coordinatorId: "codex-local",
    });
    let task = await create(service, workspace, {
      ...plan,
      contract: { autoAnswer: true },
    });
    task = await settle(service, await service.action(task.id, "dispatch"));
    assert.equal(task.status, "needs_input");
    await service.action(task.id, "poll");
    assert.equal(
      service.store.messages(task.id).filter((m) => m.kind === "question")
        .length,
      1,
    );
    await service.tick();
    await service.drainBackground();
    task = await settle(service, service.store.task(task.id));
    assert.equal(task.status, "pending_review");
    assert.equal(questions, 1);
    assert.equal(sessions[0], sessions[1]);
    assert.equal(
      service.store.messages(task.id).find((m) => m.kind === "question").state,
      "delivered",
    );
  } finally {
    service.close();
  }
});

test("user decisions remain pending instead of repeated automatic main calls", async () => {
  let questions = 0;
  const { service, workspace } = await setup((connection, { role }) => ({
    ...immediate(connection),
    async run(_prompt, id) {
      if (role === "coordinator" && !id)
        return {
          threadId: "main",
          text: JSON.stringify({
            plan: ["Implement"],
            acceptance: ["Artifact"],
          }),
        };
      if (role === "coordinator") {
        questions++;
        return {
          threadId: id,
          text: JSON.stringify({
            decision: "ask_user",
            answer: "Which external account may be used?",
          }),
        };
      }
      return {
        text: JSON.stringify({
          status: "needs_input",
          question: "May I use an external account?",
        }),
      };
    },
  }));
  try {
    const plan = await service.analyze({
      goal: "Scoped fixture",
      coordinatorId: "codex-local",
    });
    let task = await create(service, workspace, {
      ...plan,
      contract: { autoAnswer: true },
    });
    task = await settle(service, await service.action(task.id, "dispatch"));
    await service.tick();
    await service.drainBackground();
    await service.tick();
    await service.drainBackground();
    assert.equal(questions, 1);
    assert.equal(service.store.task(task.id).status, "needs_input");
    assert.match(service.store.task(task.id).userQuestion, /external account/);
    assert.equal(
      service.store.messages(task.id).find((m) => m.kind === "question").state,
      "needs_user",
    );
  } finally {
    service.close();
  }
});

test("no-progress rework pauses and token observations enforce a task budget", async () => {
  const { service, workspace } = await setup(immediate);
  try {
    let task = await settle(
      service,
      await service.action((await create(service, workspace)).id, "dispatch"),
    );
    await service.action(task.id, "review", {
      decision: "revise",
      feedback: "Missing artifact",
    });
    task = await settle(service, await service.action(task.id, "dispatch"));
    task = await service.action(task.id, "review", {
      decision: "revise",
      feedback: "Still missing artifact",
    });
    assert.equal(task.status, "stalled");
    await assert.rejects(service.action(task.id, "dispatch"), /stalled/);
    task = await service.action(task.id, "resume");
    assert.equal(task.status, "revision_ready");
  } finally {
    service.close();
  }
  const next = await setup((connection) => ({
    ...immediate(connection),
    run: async () => ({ ...complete("done"), usage: { totalTokens: 100 } }),
  }));
  try {
    let task = await create(next.service, next.workspace, {
      contract: { maxTokens: 50 },
    });
    task = await settle(
      next.service,
      await next.service.action(task.id, "dispatch"),
    );
    assert.equal(task.status, "budget_exhausted");
    assert.equal(task.usedTokens, 100);
  } finally {
    next.service.close();
  }
});

test("invalid dependency graph is rejected; two worker fixtures create actual artifacts and integrate only after final review", async () => {
  assert.throws(
    () =>
      validateGraph([
        { id: "A", dependsOn: ["B"] },
        { id: "B", dependsOn: ["A"] },
      ]),
    /循环/,
  );
  assert.throws(
    () => validateGraph([{ id: "A", dependsOn: ["missing"] }]),
    /不存在/,
  );
  let workspace1,
    workspace2,
    finalReviews = 0;
  const workspaces = [];
  const { service, root } = await setup((connection, { role }) => ({
    ...immediate(connection),
    async run(prompt, id) {
      if (role === "executor") {
        workspaces.push(connection.cwd);
        await writeFile(
          path.join(connection.cwd, "result.txt"),
          "fixture output",
        );
        return complete("Fixture file created");
      }
      if (prompt.startsWith("你是协作主控"))
        return {
          threadId: "workflow-main",
          text: JSON.stringify({
            acceptance: ["Two outputs exist"],
            nodes: [
              {
                id: "A",
                goal: "First file",
                plan: ["Write"],
                acceptance: ["Artifact"],
                dependsOn: [],
                connectionId: "codex-local",
                workspace: workspace1,
              },
              {
                id: "B",
                goal: "Second file",
                plan: ["Write"],
                acceptance: ["Artifact"],
                dependsOn: ["A"],
                connectionId: "codex-local",
                workspace: workspace2,
              },
            ],
          }),
        };
      if (prompt.startsWith("你是原协作计划")) {
        finalReviews++;
        assert.equal(
          await readFile(path.join(workspace1, "result.txt"), "utf8"),
          "fixture output",
        );
        assert.equal(
          await readFile(path.join(workspace2, "result.txt"), "utf8"),
          "fixture output",
        );
        return {
          threadId: id,
          text: JSON.stringify({
            decision: "accept",
            feedback: "Both actual fixture files inspected",
            evidence: ["Both files contain expected fixture bytes"],
            reviseNodes: [],
          }),
        };
      }
      return { threadId: id, text: JSON.stringify(accept) };
    },
  }));
  try {
    workspace1 = path.join(root, "one");
    workspace2 = path.join(root, "two");
    await mkdir(workspace1);
    await mkdir(workspace2);
    const plan = await service.workflows.analyze({
      goal: "Two fixture outputs",
      coordinatorId: "codex-local",
    });
    const workflow = await service.workflows.create({
      ...plan,
      goal: "Two fixture outputs",
      coordinatorId: "codex-local",
    });
    service.workflows.start(workflow.id);
    for (
      let i = 0;
      i < 30 && service.workflows.get(workflow.id).status !== "accepted";
      i++
    ) {
      await service.tick();
      await service.drainBackground();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.workflows.get(workflow.id).status, "accepted");
    assert.equal(finalReviews, 1);
    assert.deepEqual(workspaces, [workspace1, workspace2]);
    assert.ok(
      workflow.taskIds.every(
        (id) => service.store.task(id).status === "accepted",
      ),
    );
  } finally {
    service.close();
  }
});
