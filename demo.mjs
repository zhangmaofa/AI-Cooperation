import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Relay } from './src/relay.mjs';

// This is a deterministic protocol simulation. It does not call a real model.
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-relay-demo-'));
let sends = 0;
const adapter = {
  async send(request) {
    sends++;
    if (sends === 1) return { kind: 'task', id: 'remote-1', contextId: 'demo-context', status: { state: 'input-required', message: { parts: [{ kind: 'text', text: 'Which output file should I use?' }] } } };
    return {
      kind: 'task', id: sends === 2 ? 'remote-1' : 'remote-2', contextId: request.contextId,
      status: { state: 'completed' },
      artifacts: [{ parts: [{ kind: 'text', text: sends === 2 ? 'Draft lacks verification.' : 'Revised report includes verification.' }] }],
    };
  },
};
const relay = new Relay({ root, adapterFactory: () => adapter });
const owner = 'demo-coordinator';
let task = await relay.create({ ownerThreadId: owner, goal: 'Produce a verified report', plan: ['Write', 'Verify'], acceptance: ['Verification is included'], executor: { type: 'demo' } });
async function step(label, action) {
  task = await action();
  console.log(JSON.stringify({ step: label, status: task.status, contextId: task.contextId, remoteTaskId: task.remoteTaskId, rounds: task.rounds }));
}
await step('delegate', () => relay.dispatch(task.id, owner));
await step('answer clarification', () => relay.answer(task.id, owner, 'Use the scoped report file.'));
await step('reject first delivery', () => relay.review(task.id, owner, { decision: 'revise', feedback: 'Add verification evidence.' }));
await step('continue original conversation', () => relay.dispatch(task.id, owner));
await step('accept verified delivery', () => relay.review(task.id, owner, { decision: 'accept', feedback: 'Simulated review passed.', evidence: [{ criterionId: 'C1', passed: true, reference: 'demo-only simulated verification' }] }));
console.log(`SIMULATION ONLY. Retained task evidence: ${root}`);
