import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMcpMemoryBridge } from './mcp-memory-bridge.mjs';

test('mcp memory bridge: handles direct HTTP POST JSON-RPC initialize and tools/list', async () => {
  const bridge = createMcpMemoryBridge();
  const server = http.createServer(async (req, res) => {
    const handled = await bridge.handleRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Initialize
    const initRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' }
      })
    });
    assert.equal(initRes.status, 200);
    const initData = await initRes.json();
    assert.equal(initData.id, 1);
    assert.equal(initData.result.serverInfo.name, 'kb-context-cache');

    // 2. tools/list
    const toolsRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      })
    });
    assert.equal(toolsRes.status, 200);
    const toolsData = await toolsRes.json();
    assert.equal(toolsData.id, 2);
    const toolNames = toolsData.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes('query_context_cache'));
    assert.ok(toolNames.includes('fetch_topic_note'));
  } finally {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mcp memory bridge: handles SSE transport lifecycle with initialize and query_context_cache', async () => {
  const bridge = createMcpMemoryBridge();
  const server = http.createServer(async (req, res) => {
    const handled = await bridge.handleRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Establish SSE stream
    const controller = new AbortController();
    const sseRes = await fetch(`${baseUrl}/mcp/memory`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    // Read endpoint event
    let endpointUrl = null;
    while (!endpointUrl) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const match = sseBuffer.match(/event:\s*endpoint\s*\ndata:\s*([^\n\r]+)/);
      if (match) {
        endpointUrl = match[1].trim();
        sseBuffer = sseBuffer.slice(match.index + match[0].length);
      }
    }

    assert.ok(endpointUrl, 'Expected endpoint event from SSE');
    assert.ok(endpointUrl.startsWith('/mcp/memory/message?sessionId='));

    // 2. Post initialize message to endpoint
    const initPostRes = await fetch(`${baseUrl}${endpointUrl}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' }
      })
    });
    assert.equal(initPostRes.status, 202);

    // 3. Receive initialize response via SSE
    let initResponse = null;
    while (!initResponse) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const match = sseBuffer.match(/event:\s*message\s*\ndata:\s*([^\n\r]+)/);
      if (match) {
        initResponse = JSON.parse(match[1]);
        sseBuffer = sseBuffer.slice(match.index + match[0].length);
      }
    }

    assert.equal(initResponse.id, 10);
    assert.equal(initResponse.result.serverInfo.name, 'kb-context-cache');

    // 4. Post tools/call for query_context_cache
    const callPostRes = await fetch(`${baseUrl}${endpointUrl}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'query_context_cache',
          arguments: { query: 'memory', limit: 2 }
        }
      })
    });
    assert.equal(callPostRes.status, 202);

    // 5. Receive tools/call response via SSE
    let callResponse = null;
    while (!callResponse) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const match = sseBuffer.match(/event:\s*message\s*\ndata:\s*([^\n\r]+)/);
      if (match) {
        callResponse = JSON.parse(match[1]);
        sseBuffer = sseBuffer.slice(match.index + match[0].length);
      }
    }

    assert.equal(callResponse.id, 11);
    assert.ok(callResponse.result);
    assert.ok(Array.isArray(callResponse.result.content));

    controller.abort();
  } finally {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mcp memory bridge: returns false for non-mcp routes', async () => {
  const bridge = createMcpMemoryBridge();
  let handled = false;
  const req = { url: '/v1/tasks', method: 'POST' };
  const res = {};
  handled = await bridge.handleRequest(req, res);
  assert.equal(handled, false);
});

test('mcp memory bridge: cleanly falls back to built-in cache provider when external server is missing', async () => {
  const bridge = createMcpMemoryBridge({ kbServerPath: '/non/existent/path/mcp-memory-server.mjs' });
  const server = http.createServer(async (req, res) => {
    const handled = await bridge.handleRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const initRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' }
      })
    });
    assert.equal(initRes.status, 200);
    const initData = await initRes.json();
    assert.equal(initData.id, 100);
    assert.equal(initData.result.serverInfo.name, 'kb-context-cache');

    const toolsRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/list',
        params: {}
      })
    });
    assert.equal(toolsRes.status, 200);
    const toolsData = await toolsRes.json();
    assert.equal(toolsData.id, 101);
    const toolNames = toolsData.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes('query_context_cache'));
  } finally {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
