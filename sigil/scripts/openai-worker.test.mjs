// openai-worker auto-routing (issue #49 task 7). No network: fetch and the
// router client are injected. W3 chooses local_no_api_key when SIGIL_MODEL=auto
// and there is no API key, and does not call fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AllProvidersFailedError,
  BudgetExceededError,
  LOCKED_MODEL_IDS,
} from '../relay/v1/model-router.mjs';
import {
  createChatClientFn,
  runWorkerTask,
} from './openai-worker.mjs';

const { SOL, LUNA } = LOCKED_MODEL_IDS;
const workerScript = fileURLToPath(new URL('./openai-worker.mjs', import.meta.url));

function chatResponse(content, usage = { prompt_tokens: 8, completion_tokens: 4 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'resp-test',
      choices: [{ message: { content } }],
      usage,
    }),
  };
}

function runCli(task, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(task));
  });
}

test('createChatClientFn posts bearer chat completions and forwards the abort signal', async () => {
  const signal = new AbortController().signal;
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return chatResponse('ok');
  };
  const client = createChatClientFn({
    apiKey: 'sk-test',
    baseUrl: 'http://llm.test/v1/',
    fetchImpl,
  });
  const result = await client('gpt-4o', {
    messages: [{ role: 'user', content: 'hi' }],
    signal,
    temperature: 0,
  });
  assert.equal(seen.url, 'http://llm.test/v1/chat/completions');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers.authorization, 'Bearer sk-test');
  assert.equal(seen.options.headers['content-type'], 'application/json');
  assert.equal(seen.options.signal, signal);
  assert.equal(seen.body.model, 'gpt-4o');
  assert.equal(seen.body.temperature, 0);
  assert.equal(seen.body.messages[0].content, 'hi');
  assert.equal('signal' in seen.body, false);
  assert.equal(result.choices[0].message.content, 'ok');
});

test('createChatClientFn throws provider status errors', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'bad key' } }),
  });
  const client = createChatClientFn({
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    fetchImpl,
  });
  await assert.rejects(
    () => client('gpt-4o', { messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err.message === 'bad key' && err.status === 401,
  );
});

test('W1: task.model auto routes STRUCTURED_LOGIC to Sol even when SIGIL_MODEL is explicit', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, signal: options.signal, authorization: options.headers.authorization });
    return chatResponse('det is 0');
  };
  const result = await runWorkerTask(
    { task_id: 'task_w1', model: 'auto', instruction: 'Compute matrix determinant' },
    {
      SIGIL_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'http://router.test/v1',
    },
    { fetchImpl },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://router.test/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.model, SOL);
  assert.equal(calls[0].body.messages[0].content, 'Compute matrix determinant');
  assert.equal(typeof calls[0].signal?.aborted, 'boolean');
  assert.equal('signal' in calls[0].body, false);
  assert.equal(result.task_id, 'task_w1');
  assert.equal(result.status, 'completed');
  assert.equal(result.processing, 'auto_router');
  assert.equal(result.model, SOL);
  assert.equal(result.summary, 'det is 0');
  assert.equal(result.auto_routed, true);
  assert.equal(result.bucket, 'STRUCTURED_LOGIC');
  assert.equal(result.meta.bucket, 'STRUCTURED_LOGIC');
  assert.equal(result.meta.auto_routed, true);
  assert.equal(result.meta.model_used, SOL);
  assert.equal(typeof result.estimated_cost_usd, 'number');
  assert.ok(result.estimated_cost_usd > 0);
  assert.deepEqual(result.fallback_log, []);
  assert.deepEqual(result.meta.fallback_log, []);
});

test('W1: SIGIL_MODEL=auto reads task.body.instruction and routes to Sol', async () => {
  const calls = [];
  const clientFn = async (model, payload) => {
    calls.push({ model, content: payload.messages[0].content });
    return {
      choices: [{ message: { content: 'from sol' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    };
  };
  const result = await runWorkerTask(
    { body: { task_id: 'task_body', instruction: 'Compute matrix determinant' } },
    { SIGIL_MODEL: 'auto', OPENAI_API_KEY: 'sk-test' },
    { clientFn },
  );
  assert.deepEqual(calls, [{ model: SOL, content: 'Compute matrix determinant' }]);
  assert.equal(result.task_id, 'task_body');
  assert.equal(result.processing, 'auto_router');
  assert.equal(result.model, SOL);
  assert.equal(result.meta.bucket, 'STRUCTURED_LOGIC');
  assert.equal(result.summary, 'from sol');
});

test('W1: task.messages is what the classifier sees when instruction would route elsewhere', async () => {
  const calls = [];
  const clientFn = async (model) => {
    calls.push(model);
    return {
      choices: [{ message: { content: 'matrix' } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    };
  };
  const result = await runWorkerTask(
    {
      task_id: 'task_messages',
      model: 'auto',
      instruction: 'hello',
      messages: [{ role: 'user', content: 'Compute matrix determinant' }],
    },
    { OPENAI_API_KEY: 'sk-test' },
    { clientFn },
  );
  assert.deepEqual(calls, [SOL]);
  assert.equal(result.model, SOL);
  assert.equal(result.meta.bucket, 'STRUCTURED_LOGIC');
});

test('W2: explicit task.model Luna bypasses auto routing even when SIGIL_MODEL=auto', async () => {
  let routerBuilt = false;
  class ExplodingRouter {
    constructor() {
      routerBuilt = true;
      throw new Error('AutoRouter must not run for an explicit model');
    }
  }
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return chatResponse('from luna');
  };
  const result = await runWorkerTask(
    {
      task_id: 'task_luna',
      model: LUNA,
      instruction: 'Compute matrix determinant',
    },
    {
      SIGIL_MODEL: 'auto',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'http://router.test/v1',
    },
    { fetchImpl, AutoRouter: ExplodingRouter },
  );
  assert.equal(routerBuilt, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, LUNA);
  assert.equal(calls[0].messages[0].content, 'Compute matrix determinant');
  assert.equal(result.auto_routed, undefined);
  assert.equal(result.bucket, undefined);
  assert.deepEqual(result, {
    task_id: 'task_luna',
    status: 'completed',
    processing: 'chat_completions_api',
    model: LUNA,
    summary: 'from luna',
  });
});

test('W2: explicit SIGIL_MODEL calls that model once and does not classify', async () => {
  const calls = [];
  const clientFn = async (model) => {
    calls.push(model);
    return { choices: [{ message: { content: 'pinned' } }] };
  };
  const result = await runWorkerTask(
    { task_id: 'task_pin', instruction: 'Compute matrix determinant' },
    { SIGIL_MODEL: LUNA, OPENAI_API_KEY: 'sk-test' },
    { clientFn },
  );
  assert.deepEqual(calls, [LUNA]);
  assert.equal(result.processing, 'chat_completions_api');
  assert.equal(result.model, LUNA);
  assert.equal(result.auto_routed, undefined);
  assert.equal(result.bucket, undefined);
  assert.equal(result.summary, 'pinned');
});

test('non-auto API failure keeps local_fallback_after_api_error', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: 'boom' } }),
  });
  const result = await runWorkerTask(
    { task_id: 'task_fail', instruction: 'Hello' },
    { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'http://router.test/v1', SIGIL_MODEL: 'gpt-4o' },
    { fetchImpl },
  );
  assert.deepEqual(result, {
    task_id: 'task_fail',
    status: 'completed',
    processing: 'local_fallback_after_api_error',
    model: 'gpt-4o',
    api_error: 'boom',
    summary: 'Processed (local fallback): Hello',
  });
});

test('non-auto with no API key returns local_no_api_key and does not fetch', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('network');
  };
  const result = await runWorkerTask(
    { body: { task_id: 'nested', instruction: 'from body' } },
    { SIGIL_MODEL: 'gpt-4o' },
    { fetchImpl },
  );
  assert.equal(called, false);
  assert.deepEqual(result, {
    task_id: 'nested',
    status: 'completed',
    processing: 'local_no_api_key',
    model: 'gpt-4o',
    api_error: null,
    summary: 'Processed (local fallback): from body',
  });
});

test('missing instruction with no API key uses the empty-instruction summary', async () => {
  const result = await runWorkerTask({ task_id: 'bare' }, {});
  assert.equal(result.processing, 'local_no_api_key');
  assert.equal(result.model, 'gpt-4o');
  assert.equal(result.summary, 'Processed: (no instruction provided)');
});

test('GROK_API_KEY selects the xAI base URL and grok-beta unless SIGIL_MODEL is set', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.authorization });
    return chatResponse('grok text');
  };
  const result = await runWorkerTask(
    { task_id: 'grok', instruction: 'ping' },
    { GROK_API_KEY: 'xai-key' },
    { fetchImpl },
  );
  assert.equal(calls[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer xai-key');
  assert.equal(calls[0].body.model, 'grok-beta');
  assert.equal(result.model, 'grok-beta');
  assert.equal(result.processing, 'chat_completions_api');
  assert.equal(result.summary, 'grok text');
});

test('W3: SIGIL_MODEL=auto with no API key returns local_no_api_key and does not fetch', async () => {
  // Choice: skip AutoRouter entirely. There is no client to dispatch to, and
  // the historical no-key path already completes locally instead of hanging
  // or failing the process.
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('network');
  };
  const result = await runWorkerTask(
    { task_id: 'task_w3', instruction: 'Compute matrix determinant' },
    { SIGIL_MODEL: 'auto' },
    { fetchImpl },
  );
  assert.equal(called, false);
  assert.deepEqual(result, {
    task_id: 'task_w3',
    status: 'completed',
    processing: 'local_no_api_key',
    model: 'auto',
    api_error: null,
    summary: 'Processed (local fallback): Compute matrix determinant',
  });
});

test('W4: BudgetExceededError from the router is a failed worker result', async () => {
  class BudgetRouter {
    constructor(_config, clientFn) {
      this.clientFn = clientFn;
    }

    async routeAndExecute() {
      throw new BudgetExceededError('over cap', {
        bucket: 'STRUCTURED_LOGIC',
        model: SOL,
        estimated_cost_usd: 1.25,
        per_request_budget_usd: 0.08,
        action: 'REJECT',
      });
    }
  }
  let called = false;
  const result = await runWorkerTask(
    { task_id: 'task_budget', model: 'auto', instruction: 'Compute matrix determinant' },
    { OPENAI_API_KEY: 'sk-test' },
    {
      AutoRouter: BudgetRouter,
      fetchImpl: async () => {
        called = true;
        throw new Error('network');
      },
    },
  );
  assert.equal(called, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.processing, 'auto_router');
  assert.equal(result.error_code, 'BUDGET_EXCEEDED');
  assert.equal(result.task_id, 'task_budget');
  assert.equal(result.model, SOL);
  assert.equal(result.bucket, 'STRUCTURED_LOGIC');
  assert.equal(result.meta.bucket, 'STRUCTURED_LOGIC');
  assert.equal(result.estimated_cost_usd, 1.25);
  assert.match(result.error, /over cap/);
  assert.equal(result.summary, result.error);
});

test('W4: AllProvidersFailedError from the router is a failed worker result', async () => {
  const log = [{ from_model: SOL, to_model: LUNA, reason: 'HTTP 503', abandoned_cost_usd: 0 }];
  class FailedRouter {
    async routeAndExecute() {
      throw new AllProvidersFailedError('All providers failed for bucket STRUCTURED_LOGIC', {
        attempts: [SOL, LUNA],
        fallback_log: log,
      });
    }
  }
  const result = await runWorkerTask(
    { task_id: 'task_all', model: 'auto', instruction: 'Compute matrix determinant' },
    { OPENAI_API_KEY: 'sk-test' },
    { AutoRouter: FailedRouter },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'ALL_PROVIDERS_FAILED');
  assert.equal(result.processing, 'auto_router');
  assert.equal(result.model, 'auto');
  assert.equal(result.fallback_log.length, 1);
  assert.equal(result.fallback_log[0].from_model, SOL);
  assert.equal(result.meta.error_code, 'ALL_PROVIDERS_FAILED');
  assert.match(result.summary, /All providers failed/);
});

test('W4: a real router budget reject fails before the client is called', async () => {
  let calls = 0;
  const clientFn = async () => {
    calls += 1;
    throw new Error('should not be called');
  };
  const result = await runWorkerTask(
    { task_id: 'task_real_budget', model: 'auto', instruction: 'Compute matrix determinant' },
    {
      OPENAI_API_KEY: 'sk-test',
      SIGIL_ROUTER_BUDGET_USD: '0',
      SIGIL_ROUTER_OVER_BUDGET: 'REJECT',
    },
    { clientFn },
  );
  assert.equal(calls, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'BUDGET_EXCEEDED');
  assert.equal(result.bucket, 'STRUCTURED_LOGIC');
  assert.equal(result.model, SOL);
  assert.equal(typeof result.estimated_cost_usd, 'number');
  assert.ok(result.estimated_cost_usd > 0);
});

test('W4: a real router exhausts the Sol to Luna chain as AllProvidersFailedError', async () => {
  const calls = [];
  const clientFn = async (model) => {
    calls.push(model);
    const err = new Error('upstream down');
    err.status = 503;
    throw err;
  };
  const result = await runWorkerTask(
    { task_id: 'task_real_all', model: 'auto', instruction: 'Compute matrix determinant' },
    { OPENAI_API_KEY: 'sk-test' },
    { clientFn },
  );
  assert.deepEqual(calls, [SOL, LUNA]);
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'ALL_PROVIDERS_FAILED');
  assert.equal(result.fallback_log.length, 2);
  assert.equal(result.fallback_log[0].from_model, SOL);
  assert.equal(result.fallback_log[1].from_model, LUNA);
});

test('auto path surfaces a fail-fast provider error instead of local fallback', async () => {
  const calls = [];
  const clientFn = async (model) => {
    calls.push(model);
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  };
  const result = await runWorkerTask(
    { task_id: 'task_401', model: 'auto', instruction: 'Compute matrix determinant' },
    { OPENAI_API_KEY: 'sk-test' },
    { clientFn },
  );
  assert.deepEqual(calls, [SOL]);
  assert.equal(result.status, 'failed');
  assert.equal(result.processing, 'auto_router');
  assert.equal(result.error_code, 'HTTP_401');
  assert.notEqual(result.processing, 'local_fallback_after_api_error');
});

test('SIGIL_ROUTER_MATRIX replaces the locked primary for STRUCTURED_LOGIC', async () => {
  const calls = [];
  const clientFn = async (model) => {
    calls.push(model);
    return {
      choices: [{ message: { content: 'custom' } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    };
  };
  const result = await runWorkerTask(
    { task_id: 'task_matrix', model: 'auto', instruction: 'Compute matrix determinant' },
    {
      OPENAI_API_KEY: 'sk-test',
      SIGIL_ROUTER_MATRIX: JSON.stringify({
        STRUCTURED_LOGIC: ['custom-sol', 'custom-luna'],
        VISUAL_CODE: ['custom-sol'],
        HIGH_VOLUME_SUMMARIZATION: ['custom-sol'],
        DEEP_REASONING: ['custom-sol'],
      }),
    },
    { clientFn },
  );
  assert.deepEqual(calls, ['custom-sol']);
  assert.equal(result.model, 'custom-sol');
  assert.equal(result.meta.bucket, 'STRUCTURED_LOGIC');
});

test('invalid SIGIL_ROUTER_MATRIX throws before fetch', async () => {
  let called = false;
  await assert.rejects(
    () => runWorkerTask(
      { model: 'auto', instruction: 'Compute matrix determinant' },
      { OPENAI_API_KEY: 'sk-test', SIGIL_ROUTER_MATRIX: '{' },
      {
        fetchImpl: async () => {
          called = true;
          throw new Error('network');
        },
      },
    ),
    /Invalid SIGIL_ROUTER_MATRIX/,
  );
  assert.equal(called, false);
});

test('CLI with no API key writes local_no_api_key JSON and exits 0', async () => {
  const result = await runCli(
    { task_id: 'cli_local', instruction: 'ping' },
    {
      GROK_API_KEY: '',
      OPENAI_API_KEY: '',
      GROK_BASE_URL: '',
      OPENAI_BASE_URL: '',
      SIGIL_MODEL: 'gpt-4o',
      SIGIL_ROUTER_MATRIX: '',
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const body = JSON.parse(result.stdout);
  assert.equal(body.task_id, 'cli_local');
  assert.equal(body.status, 'completed');
  assert.equal(body.processing, 'local_no_api_key');
  assert.equal(body.model, 'gpt-4o');
  assert.match(body.summary, /Processed \(local fallback\): ping/);
});

test('CLI auto budget reject exits 1 with failed JSON and does not need the network', async () => {
  // Budget REJECT throws inside the router before clientFn, so this process
  // never calls fetch. Base URL points at a closed local port only as a backstop.
  const result = await runCli(
    { task_id: 'cli_budget', instruction: 'Compute matrix determinant' },
    {
      GROK_API_KEY: '',
      OPENAI_API_KEY: 'sk-test',
      GROK_BASE_URL: '',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      SIGIL_MODEL: 'auto',
      SIGIL_ROUTER_BUDGET_USD: '0',
      SIGIL_ROUTER_OVER_BUDGET: 'REJECT',
      SIGIL_ROUTER_MATRIX: '',
      SIGIL_ROUTER_COSTS: '',
    },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /BUDGET_EXCEEDED/);
  const body = JSON.parse(result.stdout);
  assert.equal(body.task_id, 'cli_budget');
  assert.equal(body.status, 'failed');
  assert.equal(body.error_code, 'BUDGET_EXCEEDED');
  assert.equal(body.processing, 'auto_router');
  assert.equal(body.model, SOL);
});

test('CLI rejects invalid task JSON', async () => {
  const child = spawn(process.execPath, [workerScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GROK_API_KEY: '', OPENAI_API_KEY: '', SIGIL_MODEL: 'gpt-4o' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end('not json');
  });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /openai-worker error:/);
});
