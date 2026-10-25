import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { A2AAdapter, resultText } from './a2a.mjs';

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text`);
  return value;
}
function strings(value, name) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty list`);
  return value.map((v, i) => requireText(v, `${name}[${i}]`));
}
const terminal = new Set(['accepted', 'failed', 'canceled', 'budget_exhausted']);

export class Relay {
  constructor({ root, adapterFactory } = {}) {
    this.root = root ?? process.env.AGENT_RELAY_HOME ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'AgentRelay');
    this.adapterFactory = adapterFactory ?? (config => {
      if (config.type !== 'a2a') throw new Error(`Adapter not implemented: ${config.type}`);
      return new A2AAdapter(config);
    });
  }

  file(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid relay task ID');
    return path.join(this.root, `${id}.json`);
  }

  async read(id, ownerThreadId) {
    const task = JSON.parse(await readFile(this.file(id), 'utf8'));
    if (task.ownerThreadId !== ownerThreadId) throw new Error('Task belongs to a different coordinator thread');
    return task;
  }

  async save(task) {
    const temp = `${this.file(task.id)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(task, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temp, this.file(task.id));
    } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }

  async locked(id, ownerThreadId, action) {
    const lock = `${this.file(id)}.lock`;
    try { await mkdir(lock); } catch (e) {
      if (e.code === 'EEXIST') throw new Error('Task is busy, or a crashed operation needs recovery; do not resend blindly');
      throw e;
    }
    try { return await action(await this.read(id, ownerThreadId)); }
    finally { await rmdir(lock); }
  }

  event(task, type, detail = {}) {
    task.events.push({ seq: task.events.length + 1, at: new Date().toISOString(), type, ...detail });
    task.updatedAt = task.events.at(-1).at;
  }

  async create({ ownerThreadId, goal, plan, acceptance, executor, maxRounds = 5 }) {
    requireText(ownerThreadId, 'ownerThreadId'); requireText(goal, 'goal');
    const steps = strings(plan, 'plan'); const checks = strings(acceptance, 'acceptance');
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) throw new Error('maxRounds must be 1..100');
    if (!executor || !['type', 'endpoint', 'tokenEnv'].every(k => executor[k] === undefined || typeof executor[k] === 'string')) throw new Error('Invalid executor');
    // Persist only connection references. Never store a bearer token in task data.
    const config = { type: requireText(executor.type, 'executor.type'), endpoint: executor.endpoint, tokenEnv: executor.tokenEnv };
    this.adapterFactory(config); // Validate before writing a task.
    const task = {
      id: randomUUID(), ownerThreadId, goal, plan: steps,
      acceptance: checks.map((text, index) => ({ id: `C${index + 1}`, text })),
      executor: config, maxRounds, rounds: 0, status: 'ready',
      contextId: null, remoteTaskId: null, pending: null, result: null, reviews: [], events: [],
    };
    this.event(task, 'created');
    await mkdir(this.root, { recursive: true });
    await this.save(task);
    return task;
  }

  prompt(task) {
    return JSON.stringify({
      relayTaskId: task.id, goal: task.goal, plan: task.plan, acceptance: task.acceptance,
      instruction: 'Execute the assigned plan. Report actual changed files/artifacts and verification evidence. Ask the coordinator when task information is missing. Only the coordinator can accept the result. Do not expand the authorized scope.',
      feedback: task.reviews.at(-1)?.decision === 'revise' ? task.reviews.at(-1).feedback : undefined,
    }, null, 2);
  }

  async transmit(task, text, { answer = false } = {}) {
    const adapter = this.adapterFactory(task.executor);
    const request = {
      text, contextId: task.contextId, taskId: answer ? task.remoteTaskId : null, messageId: randomUUID(),
    };
    task.pending = request;
    task.status = 'sending';
    if (!answer) task.rounds++;
    this.event(task, answer ? 'answer_sending' : 'execution_sending', { messageId: request.messageId });
    await this.save(task); // A crash after this point must never cause an automatic duplicate send.
    try {
      const result = await adapter.send(request);
      this.applyRemote(task, result);
      task.pending = null;
    } catch (e) {
      task.status = 'delivery_unknown';
      this.event(task, 'delivery_unknown', { message: String(e.message) });
    }
    await this.save(task);
    return task;
  }

  async dispatch(id, ownerThreadId) {
    return this.locked(id, ownerThreadId, async task => {
      if (!['ready', 'revision_ready'].includes(task.status)) throw new Error(`Cannot dispatch from ${task.status}`);
      if (task.rounds >= task.maxRounds) throw new Error('Round budget exhausted');
      return this.transmit(task, this.prompt(task));
    });
  }

  applyRemote(task, result) {
    if (!result.contextId) throw new Error('Executor omitted contextId; same-session continuation cannot be guaranteed');
    if (task.contextId && task.contextId !== result.contextId) throw new Error('Executor changed contextId; session binding rejected');
    if (result.kind === 'task' && !result.id) throw new Error('Executor omitted task ID');
    task.contextId = result.contextId;
    task.remoteTaskId = result.kind === 'task' ? result.id : null;
    task.result = { text: resultText(result), remote: result };
    const state = result.kind === 'message' ? 'completed' : result.status?.state;
    const mapping = {
      submitted: 'working', working: 'working', 'input-required': 'needs_input',
      'auth-required': 'needs_user', completed: 'pending_review',
      failed: 'failed', canceled: 'canceled', rejected: 'failed',
    };
    if (!mapping[state]) throw new Error(`Unrecognized executor state: ${state}`);
    const previous = task.status;
    task.status = mapping[state];
    if (previous !== task.status) this.event(task, task.status, { remoteTaskId: task.remoteTaskId, contextId: task.contextId });
  }

  async poll(id, ownerThreadId) {
    return this.locked(id, ownerThreadId, async task => {
      if (!['working', 'needs_input', 'needs_user'].includes(task.status)) return task;
      if (!task.remoteTaskId) throw new Error('Missing remote task ID');
      const result = await this.adapterFactory(task.executor).poll(task.remoteTaskId);
      if (result.kind !== 'task' || result.id !== task.remoteTaskId) throw new Error('Poll returned a different remote task');
      this.applyRemote(task, result);
      await this.save(task);
      return task;
    });
  }

  async answer(id, ownerThreadId, text) {
    requireText(text, 'answer');
    return this.locked(id, ownerThreadId, async task => {
      if (task.status !== 'needs_input') throw new Error('Only task clarification can be answered automatically; authentication/permission must be handled by the user');
      return this.transmit(task, text, { answer: true });
    });
  }

  async review(id, ownerThreadId, { decision, feedback, evidence = [] }) {
    requireText(feedback, 'feedback');
    if (!['accept', 'revise'].includes(decision)) throw new Error('decision must be accept or revise');
    return this.locked(id, ownerThreadId, async task => {
      if (task.status !== 'pending_review') throw new Error(`Cannot review from ${task.status}`);
      if (decision === 'accept') {
        if (!Array.isArray(evidence) || evidence.length !== task.acceptance.length) throw new Error('Acceptance requires evidence for every criterion');
        const ids = new Set();
        for (const check of evidence) {
          if (!task.acceptance.some(c => c.id === check.criterionId) || ids.has(check.criterionId) || check.passed !== true) throw new Error('Missing, duplicate or failed acceptance criterion');
          requireText(check.reference, 'evidence.reference'); ids.add(check.criterionId);
        }
      }
      task.reviews.push({ decision, feedback, evidence, at: new Date().toISOString(), round: task.rounds });
      task.status = decision === 'accept' ? 'accepted' : task.rounds >= task.maxRounds ? 'budget_exhausted' : 'revision_ready';
      this.event(task, task.status, { decision });
      await this.save(task);
      return task;
    });
  }

  async wait(id, ownerThreadId, { afterSeq = 0, timeoutMs = 30000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 45000) throw new Error('timeoutMs must be 0..45000');
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error('afterSeq must be a non-negative integer');
    const until = Date.now() + timeoutMs;
    let task;
    do {
      task = await this.read(id, ownerThreadId);
      if (task.status === 'working') task = await this.poll(id, ownerThreadId);
      const events = task.events.filter(e => e.seq > afterSeq);
      if (events.length || task.status !== 'working' || terminal.has(task.status)) return { task, events, cursor: task.events.length };
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(750, until - Date.now())));
    } while (Date.now() < until);
    return { task, events: task.events.filter(e => e.seq > afterSeq), cursor: task.events.length };
  }
}
