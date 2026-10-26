// Sigil OpenAI / xAI Grok task worker.
//
// stdin: one JSON task object. stdout: one JSON result object. Exit 0 when
// the result status is completed. Exit 1 on parse/config errors and when the
// auto router returns status failed. Logs go to stderr only.
//
// Model selection, first non-empty string wins:
//   task.model, task.body.model, SIGIL_MODEL,
//   else grok-beta when GROK_API_KEY is set, else gpt-4o.
// "auto" runs AutoRouter (issue #49). Any other model is one chat completion,
// with the same local fallback the worker used before auto routing existed.
//
// Auto routing calls the network only when an API key or an injected clientFn
// is present. With neither, the worker returns local_no_api_key and does not
// fetch. Router budget and provider failures are status "failed" (not a
// task.result status the relay schema accepts), so the CLI exits 1 and the
// agent daemon does not emit that body as task.result.
//
// Optional router env, applied on top of createDefaultRouteConfig plus the
// locked issue #49 matrix and rate card. SIGIL_ROUTER_MATRIX and
// SIGIL_ROUTER_COSTS replace those objects; they are not deep-merged.
//   SIGIL_ROUTER_BUDGET_USD, SIGIL_ROUTER_OVER_BUDGET,
//   SIGIL_ROUTER_LATENCY_MS, SIGIL_ROUTER_DEEP_LATENCY_MS,
//   SIGIL_ROUTER_COOLDOWN_SEC, SIGIL_ROUTER_DEFAULT_MODEL,
//   SIGIL_ROUTER_EXPECTED_COMPLETION_TOKENS,
//   SIGIL_ROUTER_MATRIX, SIGIL_ROUTER_COSTS.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutoRouter,
  createDefaultRouteConfig,
  createLockedRouteConfig,
} from '../relay/v1/model-router.mjs';

export function createChatClientFn({ apiKey, baseUrl, fetchImpl } = {}) {
  if (!apiKey) throw new Error('chat client requires an API key');
  if (!baseUrl) throw new Error('chat client requires a base URL');
  const doFetch = fetchImpl ?? globalThis.fetch;
  const root = String(baseUrl).replace(/\/+$/, '');
  return async function chatClient(model, payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const { signal, ...rest } = source;
    const response = await doFetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...rest, model }),
      signal,
    });
    const parsed = await response.json();
    if (!response.ok) {
      const err = new Error(parsed?.error?.message ?? `API error HTTP ${response.status}`);
      err.status = response.status;
      if (parsed?.usage) err.usage = parsed.usage;
      throw err;
    }
    return parsed;
  };
}

function taskIdOf(task) {
  return task?.task_id ?? task?.body?.task_id ?? null;
}

function instructionOf(task) {
  return task?.instruction ?? task?.body?.instruction ?? '';
}

function firstModel(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

export function resolveWorkerSettings(task, env) {
  const apiKey = env.GROK_API_KEY || env.OPENAI_API_KEY || '';
  const baseUrl = env.GROK_BASE_URL
    || env.OPENAI_BASE_URL
    || (env.GROK_API_KEY ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1');
  const fallbackModel = env.GROK_API_KEY ? 'grok-beta' : 'gpt-4o';
  const model = firstModel(task?.model, task?.body?.model, env.SIGIL_MODEL) || fallbackModel;
  return { apiKey, baseUrl, model };
}

function messageList(value) {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function buildWorkerMessages(task) {
  const listed = messageList(task?.messages) ?? messageList(task?.body?.messages);
  if (listed) return listed;
  const instruction = instructionOf(task);
  return [{ role: 'user', content: instruction || JSON.stringify(task) }];
}

function optionalNumber(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function optionalString(raw) {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

function jsonObjectEnv(raw, name) {
  if (raw == null || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${name}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${name}: expected a JSON object`);
  }
  return parsed;
}

// Locked issue #49 matrix and rate card, with createDefaultRouteConfig's
// latency, cooldown, and budget unless the environment overrides them.
export function routeConfigForEnv(env) {
  const fixture = createLockedRouteConfig();
  const overrides = {};
  const budget = optionalNumber(env.SIGIL_ROUTER_BUDGET_USD);
  if (budget != null) overrides.per_request_budget_usd = budget;
  const over = optionalString(env.SIGIL_ROUTER_OVER_BUDGET);
  if (over) overrides.over_budget_action = over;
  const latency = optionalNumber(env.SIGIL_ROUTER_LATENCY_MS);
  if (latency != null) overrides.latency_threshold_ms = latency;
  const deep = optionalNumber(env.SIGIL_ROUTER_DEEP_LATENCY_MS);
  if (deep != null) overrides.deep_latency_threshold_ms = deep;
  const cooldown = optionalNumber(env.SIGIL_ROUTER_COOLDOWN_SEC);
  if (cooldown != null) overrides.cooldown_period_sec = cooldown;
  const expected = optionalNumber(env.SIGIL_ROUTER_EXPECTED_COMPLETION_TOKENS);
  if (expected != null) overrides.expected_completion_tokens = expected;
  const defaultModel = optionalString(env.SIGIL_ROUTER_DEFAULT_MODEL);
  if (defaultModel) overrides.default_model = defaultModel;
  const matrix = jsonObjectEnv(env.SIGIL_ROUTER_MATRIX, 'SIGIL_ROUTER_MATRIX');
  if (matrix) overrides.dispatch_matrix = matrix;
  const costs = jsonObjectEnv(env.SIGIL_ROUTER_COSTS, 'SIGIL_ROUTER_COSTS');
  if (costs) overrides.provider_costs = costs;
  return createDefaultRouteConfig({
    default_model: fixture.default_model,
    dispatch_matrix: fixture.dispatch_matrix,
    provider_costs: fixture.provider_costs,
    ...overrides,
  });
}

function localResult(task, model, apiError) {
  const instruction = instructionOf(task);
  return {
    task_id: taskIdOf(task),
    status: 'completed',
    processing: apiError ? 'local_fallback_after_api_error' : 'local_no_api_key',
    model,
    api_error: apiError ?? null,
    summary: instruction
      ? `Processed (local fallback): ${instruction}`
      : 'Processed: (no instruction provided)',
  };
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'auto router failed';
}

function errorCode(err) {
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string' && err.code) return err.code;
    const status = Number(err.status ?? err.statusCode);
    if (Number.isInteger(status) && status >= 400) return `HTTP_${status}`;
  }
  return 'ROUTER_ERROR';
}

function copyLog(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (entry && typeof entry === 'object' ? { ...entry } : entry));
}

function autoFailure(task, err) {
  const code = errorCode(err);
  const message = errorMessage(err);
  const bucket = err && typeof err === 'object' ? (err.bucket ?? null) : null;
  const estimated = err && typeof err === 'object' ? finiteOrNull(err.estimated_cost_usd) : null;
  const fallbackLog = copyLog(err?.fallback_log);
  const model = err && typeof err === 'object' && typeof err.model === 'string' && err.model
    ? err.model
    : 'auto';
  return {
    task_id: taskIdOf(task),
    status: 'failed',
    processing: 'auto_router',
    model,
    summary: message,
    error: message,
    error_code: code,
    bucket,
    auto_routed: true,
    estimated_cost_usd: estimated,
    fallback_log: fallbackLog,
    meta: {
      bucket,
      auto_routed: true,
      estimated_cost_usd: estimated,
      fallback_log: fallbackLog,
      error_code: code,
      model_used: model,
    },
  };
}

function assistantText(response) {
  const content = response?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function autoSuccess(task, response, meta) {
  const summary = assistantText(response);
  if (!summary) {
    const empty = new Error('Chat completion returned no assistant content');
    empty.code = 'EMPTY_COMPLETION';
    empty.bucket = meta?.bucket ?? null;
    return autoFailure(task, empty);
  }
  const routerMeta = meta && typeof meta === 'object' ? meta : {};
  const fallbackLog = copyLog(routerMeta.fallback_log);
  const estimated = finiteOrNull(routerMeta.estimated_cost_usd);
  const model = routerMeta.model_used || 'auto';
  const bucket = routerMeta.bucket ?? null;
  const autoRouted = routerMeta.auto_routed === true;
  return {
    task_id: taskIdOf(task),
    status: 'completed',
    processing: 'auto_router',
    model,
    summary,
    bucket,
    auto_routed: autoRouted,
    estimated_cost_usd: estimated,
    fallback_log: fallbackLog,
    meta: {
      ...routerMeta,
      bucket,
      auto_routed: autoRouted,
      estimated_cost_usd: estimated,
      fallback_log: fallbackLog,
      model_used: model,
    },
  };
}

async function runSingleModel(task, model, clientFn, messages) {
  if (!clientFn) return localResult(task, model, null);
  try {
    const payload = await clientFn(model, { messages });
    const content = payload?.choices?.[0]?.message?.content;
    if (content) {
      return {
        task_id: taskIdOf(task),
        status: 'completed',
        processing: 'chat_completions_api',
        model,
        summary: content,
      };
    }
    return localResult(task, model, payload?.error?.message ?? 'API error HTTP 200');
  } catch (err) {
    return localResult(task, model, err?.message || String(err));
  }
}

export async function runWorkerTask(task, env = process.env, deps = {}) {
  if (!task || typeof task !== 'object') throw new Error('task must be an object');
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  const dependencies = deps && typeof deps === 'object' ? deps : {};
  const settings = resolveWorkerSettings(task, sourceEnv);
  const messages = buildWorkerMessages(task);
  const clientFn = dependencies.clientFn
    ?? (settings.apiKey
      ? createChatClientFn({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        fetchImpl: dependencies.fetchImpl,
      })
      : null);

  if (settings.model !== 'auto') {
    return runSingleModel(task, settings.model, clientFn, messages);
  }

  // No key and no injected client: same local fallback as the single-model
  // path. Do not construct the router, so nothing waits on the network.
  if (!clientFn) return localResult(task, 'auto', null);

  const RouterImpl = dependencies.AutoRouter ?? AutoRouter;
  const config = dependencies.routeConfig && typeof dependencies.routeConfig === 'object'
    ? dependencies.routeConfig
    : routeConfigForEnv(sourceEnv);
  const router = new RouterImpl(config, clientFn);
  try {
    const routed = await router.routeAndExecute({ model: 'auto', messages });
    return autoSuccess(task, routed?.response, routed?.meta);
  } catch (err) {
    return autoFailure(task, err);
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function startCli() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const task = JSON.parse(input);
      if (!task || typeof task !== 'object') throw new Error('task must be an object');
      const result = await runWorkerTask(task, process.env);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === 'failed') {
        console.error(`openai-worker error: ${result.error_code}: ${result.error}`);
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      console.error(`openai-worker error: ${err.message}`);
      process.exit(1);
    }
  });
}

if (isDirectRun()) startCli();
