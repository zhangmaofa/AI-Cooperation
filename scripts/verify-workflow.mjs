// Explicit live-model acceptance check. All file writes target a new temporary workspace.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopService } from "../backend/service.mjs";
const root = await mkdtemp(path.join(os.tmpdir(), "aico-live-workflow-"));
const workspace = path.join(root, "workspace"),
  one = path.join(workspace, "one"),
  two = path.join(workspace, "two");
await mkdir(one, { recursive: true });
await mkdir(two, { recursive: true });
const service = new DesktopService({
  root: path.join(root, "data"),
  codexCommand: process.env.AICO_CODEX_COMMAND || "codex.exe",
});
const main = service.store.connection("codex-local");
main.cwd = workspace;
service.store.saveConnection(main);
console.log(
  JSON.stringify({
    stage: "live-start",
    root,
    note: "Uses real Codex quota; only temporary directories are writable.",
  }),
);
try {
  await service.handle("scheduler.save", {
    maxConcurrent: 2,
    perConnection: 2,
  });
  const goal = `Complete exactly two independent implementation tasks using the existing codex-local connection: (1) In ${one}, create only result.txt containing exactly one followed by a newline. (2) In ${two}, create only result.txt containing exactly two followed by a newline. Each task includes its own file verification. Overall acceptance: both files exist and contain those exact bytes, with no other deliverable required. The two directories already exist and are authorized workspaces. Do not create a third verification task. Do not install dependencies, access network, or modify other files; these execution constraints do not request audit reports.`;
  const plan = await service.workflows.analyze({
    goal,
    coordinatorId: "codex-local",
    workspace,
  });
  if (plan.nodes.length !== 2)
    throw new Error(
      `Expected exactly two bounded tasks, got ${plan.nodes.length}`,
    );
  for (let i = 0; i < 2; i++) {
    const node = plan.nodes[i];
    if (![one, two].includes(node.workspace))
      throw new Error(
        "Planner did not select one of the authorized exact workspaces",
      );
    const expected = node.workspace === one ? "one\n" : "two\n";
    node.contract = {
      verification: [
        {
          command: process.execPath,
          args: [
            "-e",
            `const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!==${JSON.stringify(expected)})process.exit(1);console.log('exact bytes verified')`,
          ],
        },
      ],
      allowedPaths: ["result.txt"],
    };
  }
  const workflow = await service.workflows.create({
    ...plan,
    goal,
    coordinatorId: "codex-local",
    maxRounds: 3,
    autoReview: true,
  });
  service.workflows.start(workflow.id);
  const deadline = Date.now() + 720000;
  let previous = "";
  while (Date.now() < deadline) {
    await service.tick();
    const state = service.workflows.get(workflow.id),
      tasks = state.taskIds.map((id) => service.store.task(id));
    const compact = JSON.stringify({
      workflow: state.status,
      tasks: tasks.map((t) => ({
        node: t.nodeId,
        status: t.status,
        round: t.rounds,
      })),
    });
    if (compact !== previous) {
      console.log(compact);
      previous = compact;
    }
    if (state.status === "accepted") break;
    if (
      tasks.some((t) =>
        [
          "failed",
          "stalled",
          "budget_exhausted",
          "delivery_unknown",
          "needs_user",
        ].includes(t.status),
      ) ||
      state.status === "needs_attention"
    )
      throw new Error(
        `Needs investigation: ${compact}; ${state.lastError || ""}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const state = service.workflows.get(workflow.id);
  if (state.status !== "accepted")
    throw new Error("Live workflow did not reach overall acceptance");
  if (
    (await readFile(path.join(one, "result.txt"), "utf8")) !== "one\n" ||
    (await readFile(path.join(two, "result.txt"), "utf8")) !== "two\n"
  )
    throw new Error("Independent artifact inspection failed");
  const tasks = state.taskIds.map((id) => service.store.task(id));
  if (
    new Set(tasks.map((t) => t.contextId)).size !== 2 ||
    tasks.some((t) => t.contextId === state.threadId)
  )
    throw new Error("Worker and main session isolation failed");
  const evidence = {
    root,
    status: state.status,
    overallReviews: state.reviews,
    artifactsVerified: true,
    tasks: tasks.map((t) => ({
      id: t.id,
      contextId: t.contextId,
      rounds: t.rounds,
      verifications: t.verifications,
      reviews: t.reviews,
      usedTokens: t.usedTokens,
    })),
  };
  await writeFile(
    path.join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      stage: "verified",
      status: state.status,
      artifactsVerified: true,
      root,
    }),
  );
} finally {
  service.close();
}
