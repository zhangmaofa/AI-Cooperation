import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Relay } from '../src/relay.mjs';
import { A2AAdapter } from '../src/a2a.mjs';

const input = { ownerThreadId: 'coordinator-1', goal: 'Fix scoped bug', plan: ['Inspect', 'Fix', 'Verify'], acceptance: ['Regression passes'], executor: { type: 'test' } };
const done = (id = 'remote-1', contextId = 'session-1') => ({ kind: 'task', id, contextId, status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'report' }] }] });
async function fixture(adapter) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-relay-test-'));
  const relay = new Relay({ root, adapterFactory: () => adapter });
  const task = await relay.create(input);
  return { relay, task, root };
}

test('clarification uses same task; rejected delivery uses new task in SAME context; only review accepts', async () => {
  const calls = [];
  const adapter = { async send(request) {
    calls.push(request);
    if (calls.length === 1) return { ...done(), status: { state: 'input-required' } };
    return done(calls.length === 2 ? 'remote-1' : 'remote-2');
  } };
  const { relay, task } = await fixture(adapter);
  assert.equal((await relay.dispatch(task.id, input.ownerThreadId)).status, 'needs_input');
  assert.equal((await relay.answer(task.id, input.ownerThreadId, 'Scoped clarification')).status, 'pending_review');
  assert.equal(calls[1].taskId, 'remote-1');
  assert.equal(calls[1].contextId, 'session-1');
  await assert.rejects(relay.review(task.id, input.ownerThreadId, { decision: 'accept', feedback: 'Looks done' }), /evidence/);
  await relay.review(task.id, input.ownerThreadId, { decision: 'revise', feedback: 'Fix regression first' });
  const revised = await relay.dispatch(task.id, input.ownerThreadId);
  assert.equal(revised.status, 'pending_review');
  assert.equal(calls[2].taskId, null);
  assert.equal(calls[2].contextId, 'session-1');
  assert.match(calls[2].text, /Fix regression first/);
  const accepted = await relay.review(task.id, input.ownerThreadId, { decision: 'accept', feedback: 'Verified', evidence: [{ criterionId: 'C1', passed: true, reference: 'independent regression test output' }] });
  assert.equal(accepted.status, 'accepted');
});

test('transport uncertainty is persisted across restart and never blindly retried', async () => {
  let count = 0;
  const adapter = { async send() { count++; throw new Error('Connection closed after send'); } };
  const { relay, task, root } = await fixture(adapter);
  assert.equal((await relay.dispatch(task.id, input.ownerThreadId)).status, 'delivery_unknown');
  const resumed = new Relay({ root, adapterFactory: () => adapter });
  await assert.rejects(resumed.dispatch(task.id, input.ownerThreadId), /delivery_unknown/);
  assert.equal(count, 1);
  assert.equal((await resumed.read(task.id, input.ownerThreadId)).pending.messageId.length, 36);
});

test('another coordinator cannot inspect or review a task; executor cannot change context', async () => {
  let count = 0;
  const { relay, task } = await fixture({ async send() { return done('remote-' + (++count), count === 1 ? 'session-1' : 'session-OTHER'); } });
  await assert.rejects(relay.read(task.id, 'wrong-owner'), /different coordinator/);
  await relay.dispatch(task.id, input.ownerThreadId);
  await relay.review(task.id, input.ownerThreadId, { decision: 'revise', feedback: 'Repair result' });
  const result = await relay.dispatch(task.id, input.ownerThreadId);
  assert.equal(result.status, 'delivery_unknown');
  assert.equal(result.contextId, 'session-1');
});

test('round exhaustion does not become accepted', async () => {
  const { relay, root } = await fixture({ async send() { return done(); } });
  const task = await relay.create({ ...input, maxRounds: 1 });
  await relay.dispatch(task.id, input.ownerThreadId);
  const result = await relay.review(task.id, input.ownerThreadId, { decision: 'revise', feedback: 'Still broken' });
  assert.equal(result.status, 'budget_exhausted');
  assert.notEqual(result.status, 'accepted');
  const resumed = new Relay({ root });
  assert.deepEqual((await resumed.read(task.id, input.ownerThreadId)).plan, input.plan);
});

test('remote failure is never pending_review and cannot be accepted', async () => {
  const { relay, task } = await fixture({ async send() { return { ...done(), status: { state: 'failed' } }; } });
  assert.equal((await relay.dispatch(task.id, input.ownerThreadId)).status, 'failed');
  await assert.rejects(relay.review(task.id, input.ownerThreadId, { decision: 'accept', feedback: 'Done' }), /failed/);
});

test('wait returns question events with a cursor and validates poll task ID', async () => {
  const adapter = {
    async send() { return { ...done(), status: { state: 'working' } }; },
    async poll() { return { ...done(), status: { state: 'input-required' } }; },
  };
  const { relay, task } = await fixture(adapter);
  const running = await relay.dispatch(task.id, input.ownerThreadId);
  const reply = await relay.wait(task.id, input.ownerThreadId, { afterSeq: running.events.length, timeoutMs: 0 });
  assert.equal(reply.task.status, 'needs_input');
  assert.deepEqual(reply.events.map(e => e.type), ['needs_input']);
  assert.equal(reply.cursor, running.events.length + 1);
});

test('A2A wire sends token only as header, no terminal task ID on rework; JSON-RPC envelope is checked', async () => {
  process.env.AGENT_RELAY_TEST_TOKEN = 'test-only-not-a-real-credential';
  try {
    let wire;
    const adapter = new A2AAdapter({ endpoint: 'http://127.0.0.1:43120/a2a/v0.3/agents/test', tokenEnv: 'AGENT_RELAY_TEST_TOKEN' }, { fetchImpl: async (_url, options) => {
      wire = options;
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: done() }) };
    } });
    await adapter.send({ text: 'repair', contextId: 'session-1', taskId: null, messageId: 'test-message' });
    assert.equal(wire.headers.Authorization, 'Bearer test-only-not-a-real-credential');
    assert.equal(JSON.parse(wire.body).params.message.contextId, 'session-1');
    assert.equal('taskId' in JSON.parse(wire.body).params.message, false);
    assert.equal(wire.body.includes(process.env.AGENT_RELAY_TEST_TOKEN), false);
    assert.equal(wire.redirect, 'error');
  } finally { delete process.env.AGENT_RELAY_TEST_TOKEN; }
});
