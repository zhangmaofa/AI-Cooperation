import { randomUUID } from 'node:crypto';

export class A2AAdapter {
  constructor({ endpoint, tokenEnv = 'AIMANA_A2A_TOKEN' }, { fetchImpl = fetch, tokenProvider } = {}) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint must not contain credentials, query or fragment');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use HTTPS or localhost HTTP');
    this.endpoint = url.href;
    this.tokenEnv = tokenEnv;
    this.fetch = fetchImpl;
    this.tokenProvider = tokenProvider;
  }

  async rpc(method, params) {
    const token = this.tokenProvider ? await this.tokenProvider() : process.env[this.tokenEnv];
    if (!token) throw new Error(`Missing token environment variable: ${this.tokenEnv}`);
    const id = randomUUID();
    const response = await this.fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) throw new Error(`A2A HTTP ${response.status}`);
    const body = await response.json();
    if (body.id !== id || body.jsonrpc !== '2.0') throw new Error('Invalid A2A response envelope');
    if (body.error) throw new Error(`A2A RPC error ${body.error.code}`);
    if (!body.result || !['task', 'message'].includes(body.result.kind)) throw new Error('Invalid A2A result');
    return body.result;
  }

  send({ text, contextId, taskId, messageId }) {
    return this.rpc('message/send', {
      message: {
        kind: 'message', role: 'user', messageId,
        ...(contextId ? { contextId } : {}), ...(taskId ? { taskId } : {}),
        parts: [{ kind: 'text', text }],
      },
      configuration: { blocking: false, historyLength: 20 },
    });
  }

  poll(taskId) { return this.rpc('tasks/get', { id: taskId, historyLength: 20 }); }
}

export function resultText(result) {
  const parts = result.kind === 'message'
    ? result.parts ?? []
    : [...(result.status?.message?.parts ?? []), ...(result.artifacts ?? []).flatMap(a => a.parts ?? [])];
  return parts.filter(p => p.kind === 'text').map(p => p.text).join('\n');
}
