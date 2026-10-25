import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real MCP stdio handshake, discover tools, create and read persistent coordinator task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url))],
    env: { ...process.env, AGENT_RELAY_HOME: root },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agent-relay-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    const response = await client.callTool({ name: 'relay_create', arguments: {
      ownerThreadId: 'test-owner', goal: 'Test only', plan: ['Test'], acceptance: ['Test passes'],
      executor: { type: 'a2a', endpoint: 'http://127.0.0.1:43120/a2a/v0.3/agents/test' },
    } });
    assert.equal(response.isError, undefined);
    const task = JSON.parse(response.content[0].text);
    assert.equal(task.status, 'ready');
    const read = await client.callTool({ name: 'relay_get', arguments: { taskId: task.id, ownerThreadId: 'test-owner' } });
    assert.equal(JSON.parse(read.content[0].text).id, task.id);
    const wrong = await client.callTool({ name: 'relay_get', arguments: { taskId: task.id, ownerThreadId: 'another-owner' } });
    assert.equal(wrong.isError, true);
  } finally { await client.close(); }
});
