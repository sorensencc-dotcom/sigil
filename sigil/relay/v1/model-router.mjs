// Multi-model auto-routing (ACT-02 / issue #49).
// Keyword classifier, dispatch chain, failover, per-model cooldown,
// and per-request budget enforcement (downgrade, then reject).

export const Bucket = {
  STRUCTURED_LOGIC: 'STRUCTURED_LOGIC',
  VISUAL_CODE: 'VISUAL_CODE',
  HIGH_VOLUME_SUMMARIZATION: 'HIGH_VOLUME_SUMMARIZATION',
  DEEP_REASONING: 'DEEP_REASONING',
};

// Empty, ambiguous, or mixed prompts default to HIGH_VOLUME_SUMMARIZATION.
const DEFAULT_BUCKET = Bucket.HIGH_VOLUME_SUMMARIZATION;

// Outweighs a typical analytical keyword pile when an image or file is attached.
const ATTACHMENT_WEIGHT = 5;

// Whole-word hits only. Visual terms must not use a bare "view" substring:
// that would misread "review" and "overview" as UI prompts.
const PATTERNS = {
  [Bucket.STRUCTURED_LOGIC]: /\b(?:matrix|determinant|compute|calculate|math|logic|equation|formula|prove|algorithm|spreadsheet|csv|tabular|columns?)\b|\b\d+\s*[+\-*\/]\s*\d+\b/gi,
  [Bucket.VISUAL_CODE]: /\b(?:screenshots?|svg|tailwind|navbar|layouts?|css|flexbox|flex|icons?|rendering|render|ui|ux|responsive|images?)\b/gi,
  [Bucket.HIGH_VOLUME_SUMMARIZATION]: /\b(?:summarize|summarise|summary|batch|sweep|inbox|tickets?|logs?|bulk|background|drafts?|reviews?)\b/gi,
  [Bucket.DEEP_REASONING]: /\b(?:architect|multi-phase|multi-step|trade-?offs?|step-by-step|strateg(?:y|ies)|mitigation|spinoff|synthesize|synthesise|contradictory|clinical|planning|plan|migration|risks?|analysis|analyze|analyse)\b/gi,
};

function countMatches(text, pattern) {
  if (!text) return 0;
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  return text.match(re)?.length ?? 0;
}

function contentHasImage(content) {
  if (!content || typeof content !== 'object') return false;
  if (Array.isArray(content)) return content.some((part) => contentHasImage(part));
  return content.type === 'image' || content.type === 'image_url' || Boolean(content.image_url);
}

function messageHasImage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'image' || message.type === 'image_url' || message.image_url) return true;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return true;
  return contentHasImage(message.content);
}

function hasVisualAttachment(extras) {
  if (!extras || typeof extras !== 'object') return false;
  if (Array.isArray(extras.attachments) && extras.attachments.length > 0) return true;
  if (!Array.isArray(extras.messages)) return false;
  return extras.messages.some((message) => messageHasImage(message));
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => textFromContent(part)).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

function promptTextFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map((message) => textFromContent(message?.content)).filter(Boolean).join('\n');
}

function pickBucket(scores, attachment) {
  let max = 0;
  const winners = [];
  for (const [bucket, score] of Object.entries(scores)) {
    if (score > max) {
      max = score;
      winners.length = 0;
      winners.push(bucket);
    } else if (score === max && score > 0) {
      winners.push(bucket);
    }
  }
  if (max <= 0 || winners.length === 0) return DEFAULT_BUCKET;
  if (winners.length === 1) return winners[0];
  // An attached image/file wins a tie that includes VISUAL_CODE.
  if (attachment && winners.includes(Bucket.VISUAL_CODE)) return Bucket.VISUAL_CODE;
  // Tie-break: STRUCTURED_LOGIC beats DEEP_REASONING. Any other tie is mixed.
  const others = winners.filter((bucket) => bucket !== Bucket.STRUCTURED_LOGIC);
  if (winners.includes(Bucket.STRUCTURED_LOGIC) && others.every((bucket) => bucket === Bucket.DEEP_REASONING)) {
    return Bucket.STRUCTURED_LOGIC;
  }
  return DEFAULT_BUCKET;
}

// Pure classifier. `extras.attachments` or message parts with image_url / type:image
// add VISUAL_CODE weight. Never calls a model client.
export function classifyPrompt(text, extras) {
  const normalized = typeof text === 'string' ? text : text == null ? '' : String(text);
  const attachment = hasVisualAttachment(extras);
  const scores = {};
  for (const bucket of Object.values(Bucket)) {
    scores[bucket] = countMatches(normalized, PATTERNS[bucket]);
  }
  if (attachment) scores[Bucket.VISUAL_CODE] += ATTACHMENT_WEIGHT;
  return pickBucket(scores, attachment);
}

const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ABORT_ERR',
  'LATENCY_TIMEOUT',
]);

// Interactive buckets use latency_threshold_ms. DEEP_REASONING stays on the
// longer budget: deep_latency_threshold_ms when set, otherwise 8000 ms.
export function resolveLatencyThresholdMs(config, bucket) {
  if (bucket === Bucket.DEEP_REASONING) {
    const deep = Number(config?.deep_latency_threshold_ms);
    if (Number.isFinite(deep) && deep >= 0) return deep;
    return 8000;
  }
  const interactive = Number(config?.latency_threshold_ms);
  if (Number.isFinite(interactive) && interactive >= 0) return interactive;
  return 3000;
}

export function createDefaultRouteConfig(overrides = {}) {
  const defaults = {
    default_model: null,
    dispatch_matrix: {},
    latency_threshold_ms: 3000,
    deep_latency_threshold_ms: 8000,
    cooldown_period_sec: 30,
    per_request_budget_usd: 0.1,
    over_budget_action: 'DOWNGRADE',
    // Pre-dispatch completion assumption only. A response with usage replaces it.
    expected_completion_tokens: 500,
    // Cheaper models considered only when the bucket primary is over the cap
    // and over_budget_action is DOWNGRADE. An array of model ids, or a map of
    // primary model / bucket / "default" → model id or model id list.
    downgrade_targets: {},
    provider_costs: {},
  };
  return { ...defaults, ...overrides };
}

// Issue #49 model ids. Keep these aligned with lockedConfig() in
// model-router.test.mjs so worker auto-routing stays deterministic.
export const LOCKED_MODEL_IDS = {
  SOL: 'openai-gpt-6.1-sol',
  LUNA: 'openai-gpt-6.1-luna',
  SONNET: 'anthropic-claude-sonnet-5.5',
  OPUS: 'anthropic-claude-opus-5.5',
  HAIKU: 'anthropic-claude-haiku-5.5',
  FLASH: 'google-gemini-2.5-flash',
};

// Same matrix, rate card, and knobs as lockedConfig() in model-router.test.mjs.
// Callers that want the router's operational defaults (latency 3000, cooldown
// 30s, budget 0.1) should copy default_model, dispatch_matrix, and
// provider_costs onto createDefaultRouteConfig instead of using this fixture
// unchanged. The OpenAI worker does that.
export function createLockedRouteConfig(overrides = {}) {
  const { SOL, LUNA, SONNET, OPUS, HAIKU, FLASH } = LOCKED_MODEL_IDS;
  return createDefaultRouteConfig({
    default_model: SONNET,
    latency_threshold_ms: 2500,
    cooldown_period_sec: 0.2,
    per_request_budget_usd: 0.08,
    over_budget_action: 'DOWNGRADE',
    dispatch_matrix: {
      [Bucket.STRUCTURED_LOGIC]: [SOL, LUNA],
      [Bucket.VISUAL_CODE]: [SONNET, OPUS],
      [Bucket.HIGH_VOLUME_SUMMARIZATION]: [FLASH, HAIKU],
      [Bucket.DEEP_REASONING]: [OPUS, SOL],
    },
    provider_costs: {
      [SOL]: { input: 0.003, output: 0.012 },
      [LUNA]: { input: 0.0002, output: 0.0008 },
      [SONNET]: { input: 0.003, output: 0.015 },
      [OPUS]: { input: 0.015, output: 0.075 },
      [HAIKU]: { input: 0.0008, output: 0.004 },
      [FLASH]: { input: 0.0001, output: 0.0004 },
    },
    ...overrides,
  });
}

export class AllProvidersFailedError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'AllProvidersFailedError';
    this.code = 'ALL_PROVIDERS_FAILED';
    this.attempts = details.attempts ?? [];
    this.fallback_log = details.fallback_log ?? [];
  }
}

// Raised before a provider call when the pre-dispatch estimate is over the cap.
// DOWNGRADE already failed to find a cheaper in-cap model, or the action is REJECT.
export class BudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.bucket = details.bucket ?? null;
    this.model = details.model ?? null;
    this.estimated_cost_usd = details.estimated_cost_usd ?? null;
    this.per_request_budget_usd = details.per_request_budget_usd ?? null;
    this.action = details.action ?? null;
    const listed = Array.isArray(details.candidates) ? details.candidates : [];
    this.candidates = listed.map((entry) => ({ ...entry }));
  }
}

function readStatus(err) {
  if (!err || typeof err !== 'object') return null;
  const raw = err.status ?? err.statusCode;
  const status = Number(raw);
  return Number.isInteger(status) ? status : null;
}

function providerErrorFromResponse(response) {
  if (!response || typeof response !== 'object' || response instanceof Error) return null;
  const status = readStatus(response) ?? readStatus(response.error);
  if (status == null || status < 400) return null;
  const err = new Error(response.error?.message || response.message || `HTTP ${status}`);
  err.status = status;
  if (response.usage) err.usage = response.usage;
  else if (response.error?.usage) err.usage = response.error.usage;
  return err;
}

function isConnectionOrTimeout(err) {
  if (!err || typeof err !== 'object') return false;
  if (CONNECTION_CODES.has(err.code)) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const message = String(err.message ?? '').toLowerCase();
  return (
    message.includes('timeout')
    || message.includes('timed out')
    || message.includes('latency')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('enetunreach')
    || message.includes('socket hang up')
    || message.includes('fetch failed')
    || message.includes('network')
  );
}

// Retryable: 429, 408, 5xx, connection, and latency timeout.
// 400, 401, 403, 404, 422 (and any other status) fail fast with the original error.
function classifyFailure(err) {
  const status = readStatus(err);
  if (status != null) {
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'retryable';
    return 'failfast';
  }
  if (isConnectionOrTimeout(err)) return 'retryable';
  return 'failfast';
}

function failoverReason(err) {
  const status = readStatus(err);
  if (status === 429) return 'HTTP 429 throttle';
  if (status === 408) return 'HTTP 408 timeout';
  if (status != null && status >= 500 && status <= 599) return `HTTP ${status}`;
  if (err?.code === 'LATENCY_TIMEOUT' || err?.name === 'TimeoutError') {
    return err.message || 'latency timeout';
  }
  if (err?.code && CONNECTION_CODES.has(err.code)) return `connection error: ${err.code}`;
  if (isConnectionOrTimeout(err)) return `connection timeout: ${err?.message || 'network error'}`;
  return err?.message || 'retryable provider failure';
}

// Modest completion size used only for the pre-dispatch cap check.
// Successful calls replace this with response.usage when the provider sends it.
export const DEFAULT_EXPECTED_COMPLETION_TOKENS = 500;

// Pre-dispatch input size. This is not a tokenizer.
// Formula: trim the prompt, then Math.ceil(charLength / 4). Four characters
// per token is the usual English rule of thumb. Empty or whitespace-only
// prompts estimate as 0. Pass message content text only; role labels are not counted.
export function estimatePromptTokens(text) {
  const normalized = typeof text === 'string' ? text : text == null ? '' : String(text);
  const trimmed = normalized.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

export function resolveExpectedCompletionTokens(config) {
  const configured = Number(config?.expected_completion_tokens);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_EXPECTED_COMPLETION_TOKENS;
}

// USD for one model at the given token counts.
// providerCosts[model] is { input, output } in USD per 1K tokens.
// estimated_cost_usd = (inputTokens / 1000) * input + (completionTokens / 1000) * output.
// A model with no rate card estimates as 0, matching abandoned-usage billing.
export function estimateRequestCostUsd(model, inputTokens, completionTokens, providerCosts) {
  const costs = providerCosts?.[model];
  if (!costs) return 0;
  const inputRate = Number(costs.input ?? 0);
  const outputRate = Number(costs.output ?? 0);
  const prompt = Number(inputTokens ?? 0);
  const completion = Number(completionTokens ?? 0);
  if (![prompt, completion, inputRate, outputRate].every(Number.isFinite)) return 0;
  const cost = (prompt / 1000) * inputRate + (completion / 1000) * outputRate;
  if (!Number.isFinite(cost) || cost < 0) return 0;
  return cost;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// First JSON object in a fence, otherwise the first `{...}` span that parses.
// Fixture text is short. A failed parse skips that span and keeps looking.
function extractJsonObject(text) {
  const sources = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fence.exec(text);
  while (match) {
    sources.push(match[1]);
    match = fence.exec(text);
  }
  sources.push(text);
  for (const source of sources) {
    let start = source.indexOf('{');
    while (start !== -1) {
      let end = source.indexOf('}', start + 1);
      while (end !== -1) {
        try {
          const value = JSON.parse(source.slice(start, end + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch {
          // Try a longer span. Prose can contain a brace that is not JSON.
        }
        end = source.indexOf('}', end + 1);
      }
      start = source.indexOf('{', start + 1);
    }
  }
  return null;
}

// Structural quality score in 0..1. Each section header, whole-word token,
// checklist line, JSON key, and optional minimum length is one check.
// The score is the fraction of checks that pass. An empty rubric scores 1.
// Wording can differ and still tie. This never calls a model provider.
export function scoreQuality(text, rubric = {}) {
  const body = typeof text === 'string' ? text : '';
  const spec = rubric && typeof rubric === 'object' ? rubric : {};
  const checks = [];
  for (const section of asList(spec.sections)) {
    checks.push(body.includes(String(section)));
  }
  for (const token of asList(spec.requiredTokens)) {
    const pattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i');
    checks.push(pattern.test(body));
  }
  if (Number.isFinite(spec.minLength)) {
    checks.push(body.trim().length >= spec.minLength);
  }
  const jsonKeys = asList(spec.jsonKeys);
  const parsed = jsonKeys.length > 0 ? extractJsonObject(body) : null;
  for (const key of jsonKeys) {
    checks.push(parsed != null && Object.prototype.hasOwnProperty.call(parsed, key));
  }
  for (const item of asList(spec.checklist)) {
    checks.push(body.includes(String(item)));
  }
  if (checks.length === 0) return 1;
  return checks.filter(Boolean).length / checks.length;
}

function preEstimate(config, model, promptText) {
  const inputTokens = estimatePromptTokens(promptText);
  const completionTokens = resolveExpectedCompletionTokens(config);
  return {
    inputTokens,
    completionTokens,
    estimated_cost_usd: estimateRequestCostUsd(
      model,
      inputTokens,
      completionTokens,
      config?.provider_costs,
    ),
  };
}

// Null means the cap is not configured. A finite budget >= 0 is enforced.
// A negative or non-numeric cap is ignored so a bad value does not brick routing.
function requestBudgetUsd(config) {
  if (config == null || config.per_request_budget_usd == null || config.per_request_budget_usd === '') {
    return null;
  }
  const budget = Number(config.per_request_budget_usd);
  if (!Number.isFinite(budget) || budget < 0) return null;
  return budget;
}

function overBudgetAction(config) {
  const raw = String(config?.over_budget_action ?? 'DOWNGRADE').trim().toUpperCase();
  return raw === 'REJECT' ? 'REJECT' : 'DOWNGRADE';
}

function isOverBudget(cost, budget) {
  return budget != null && Number(cost) > budget;
}

function downgradeTargetModels(config, bucket, primary) {
  const configured = config?.downgrade_targets;
  const found = [];
  const push = (value) => {
    if (typeof value === 'string' && value) found.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) push(item);
    }
  };
  if (Array.isArray(configured)) push(configured);
  else if (configured && typeof configured === 'object') {
    push(configured[primary]);
    push(configured[bucket]);
    push(configured.default);
  }
  const seen = new Set();
  const unique = [];
  for (const model of found) {
    if (seen.has(model)) continue;
    seen.add(model);
    unique.push(model);
  }
  return unique;
}

function raiseBudgetExceeded(details) {
  const candidates = details.candidates ?? [];
  const budget = details.budget;
  const action = details.action;
  const list = candidates
    .map((entry) => `${entry.model} estimated ${entry.estimated_cost_usd} USD`)
    .join('; ');
  const scope = details.bucket ? ` for bucket ${details.bucket}` : '';
  const decision = action === 'REJECT'
    ? 'rejected without downgrade'
    : 'downgrade candidates are still over the cap';
  const message = `Per-request budget of ${budget} USD exceeded${scope}; ${decision}. ${list}`.trim();
  const focus = details.model ?? candidates[0]?.model ?? null;
  const focusCost = candidates.find((entry) => entry.model === focus)?.estimated_cost_usd
    ?? candidates[candidates.length - 1]?.estimated_cost_usd
    ?? null;
  throw new BudgetExceededError(message, {
    bucket: details.bucket ?? null,
    model: focus,
    estimated_cost_usd: focusCost,
    per_request_budget_usd: budget ?? null,
    action,
    candidates,
    cause: details.cause,
  });
}

function readUsage(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    prompt_tokens: Number.isFinite(prompt) && prompt >= 0 ? prompt : 0,
    completion_tokens: Number.isFinite(completion) && completion >= 0 ? completion : 0,
  };
}

// Prefer provider usage after a successful call. Missing usage keeps the pre-estimate.
function applyUsageCost(meta, {
  model,
  response,
  inputTokens,
  completionTokens,
  providerCosts,
  budgetAction,
  budgetFromModel,
  budgetSkipped,
}) {
  const actual = readUsage(response);
  const promptTokens = actual ? actual.prompt_tokens : inputTokens;
  const completionTokensUsed = actual ? actual.completion_tokens : completionTokens;
  meta.prompt_tokens = promptTokens;
  meta.completion_tokens = completionTokensUsed;
  meta.usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokensUsed,
  };
  meta.estimated_cost_usd = estimateRequestCostUsd(
    model,
    promptTokens,
    completionTokensUsed,
    providerCosts,
  );
  if (budgetAction) {
    meta.budget_action = budgetAction;
    if (budgetFromModel) meta.budget_from_model = budgetFromModel;
    if (Array.isArray(budgetSkipped) && budgetSkipped.length > 0) {
      meta.budget_skipped = budgetSkipped.map((entry) => ({ ...entry }));
    }
  }
  return meta;
}

// provider_costs rates are USD per 1K tokens. Unknown usage bills nothing.
function abandonedCostUsd(config, model, err) {
  const usage = err?.usage ?? err?.response?.usage ?? null;
  if (!usage) return 0;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return estimateRequestCostUsd(model, prompt, completion, config?.provider_costs);
}

function latencyTimeoutError(timeoutMs, cause) {
  const err = new Error(`latency timeout after ${timeoutMs}ms`);
  err.code = 'LATENCY_TIMEOUT';
  err.name = 'TimeoutError';
  if (cause) err.cause = cause;
  return err;
}

// Abort the in-flight call at the latency budget. A client that honors
// AbortSignal stops immediately; a client that does not is still abandoned
// when the timer fires, so the chain does not wait out the slow response.
function invokeWithLatencyLimit(clientFn, model, payload, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let settled = false;
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      const err = latencyTimeoutError(timeoutMs);
      controller.abort(err);
      settle(reject, err);
    }, timeoutMs);

    Promise.resolve()
      .then(() => clientFn(model, { ...payload, model, signal: controller.signal }))
      .then((value) => {
        if (value instanceof Error) throw value;
        const asError = providerErrorFromResponse(value);
        if (asError) throw asError;
        settle(resolve, value);
      })
      .catch((error) => {
        if (settled) return;
        if (readStatus(error) != null) {
          settle(reject, error);
          return;
        }
        if (
          controller.signal.aborted
          || error?.name === 'AbortError'
          || error?.name === 'TimeoutError'
          || error?.code === 'ABORT_ERR'
          || error?.code === 'LATENCY_TIMEOUT'
        ) {
          settle(reject, latencyTimeoutError(timeoutMs, error));
          return;
        }
        settle(reject, error);
      });
  });
}

function metaFor(modelUsed, { autoRouted, bucket, fallbackLog }) {
  const meta = {
    auto_routed: autoRouted,
    bucket,
    model_used: modelUsed,
    headers: { 'x-router-provider': modelUsed },
  };
  if (autoRouted) meta.fallback_log = fallbackLog;
  return meta;
}

export class AutoRouter {
  constructor(config, clientFn, options = {}) {
    this.config = config ?? {};
    this.clientFn = clientFn;
    const opts = options ?? {};
    const now = opts.now ?? this.config.now;
    this.now = typeof now === 'function' ? now : () => Date.now();
    // Model id → epoch ms when the model may receive auto traffic again.
    this.cooldownUntil = new Map();
  }

  isCoolingDown(model, now) {
    const until = this.cooldownUntil.get(model);
    return typeof until === 'number' && now < until;
  }

  openCircuit(model, now) {
    const seconds = Number(this.config.cooldown_period_sec);
    const cooldownSec = Number.isFinite(seconds) && seconds >= 0 ? seconds : 30;
    this.cooldownUntil.set(model, now + cooldownSec * 1000);
  }

  nextCandidate(chain, start, attempts, now) {
    for (let index = start; index < chain.length; index += 1) {
      const model = chain[index];
      if (!model || attempts.includes(model)) continue;
      if (this.isCoolingDown(model, now)) continue;
      return model;
    }
    return null;
  }

  async routeAndExecute(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const { model, ...rest } = source;
    const promptText = promptTextFromMessages(source.messages);

    // Pinned and default-model calls do not walk the bucket chain. An explicit
    // model that is over the cap fails before dispatch instead of being swapped.
    if (model !== 'auto') {
      const modelUsed = model || this.config.default_model;
      const estimate = preEstimate(this.config, modelUsed, promptText);
      const budget = requestBudgetUsd(this.config);
      if (isOverBudget(estimate.estimated_cost_usd, budget)) {
        raiseBudgetExceeded({
          budget,
          bucket: null,
          action: overBudgetAction(this.config),
          model: modelUsed,
          candidates: [{ model: modelUsed, estimated_cost_usd: estimate.estimated_cost_usd }],
        });
      }
      const response = await this.clientFn(modelUsed, { ...rest, model: modelUsed });
      return {
        response,
        meta: applyUsageCost(
          metaFor(modelUsed, { autoRouted: false, bucket: null }),
          {
            model: modelUsed,
            response,
            inputTokens: estimate.inputTokens,
            completionTokens: estimate.completionTokens,
            providerCosts: this.config.provider_costs,
          },
        ),
      };
    }

    const bucket = classifyPrompt(promptText, {
      attachments: source.attachments,
      messages: source.messages,
    });
    const configured = this.config.dispatch_matrix?.[bucket];
    const chain = Array.isArray(configured) ? configured.slice() : [];
    const budget = requestBudgetUsd(this.config);
    const action = overBudgetAction(this.config);
    const inputTokens = estimatePromptTokens(promptText);
    const completionTokens = resolveExpectedCompletionTokens(this.config);
    const costOf = (candidate) => estimateRequestCostUsd(
      candidate,
      inputTokens,
      completionTokens,
      this.config.provider_costs,
    );

    // Budget is a pre-dispatch gate. An over-cap model is not called and does
    // not open provider failover. DOWNGRADE continues along the bucket chain,
    // then any configured cheaper targets, and rejects if none fit. REJECT
    // throws on the first over-cap candidate.
    if (action === 'DOWNGRADE') {
      const primary = chain.find((entry) => entry);
      if (primary && isOverBudget(costOf(primary), budget)) {
        for (const extra of downgradeTargetModels(this.config, bucket, primary)) {
          if (!chain.includes(extra)) chain.push(extra);
        }
      }
    }

    const thresholdMs = resolveLatencyThresholdMs(this.config, bucket);
    const fallbackLog = [];
    const attempts = [];
    const skippedForBudget = [];
    let lastError = null;

    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index];
      if (!candidate || attempts.includes(candidate)) continue;

      const estimated = costOf(candidate);
      if (isOverBudget(estimated, budget)) {
        if (!skippedForBudget.some((entry) => entry.model === candidate)) {
          skippedForBudget.push({ model: candidate, estimated_cost_usd: estimated });
        }
        if (action === 'REJECT') {
          raiseBudgetExceeded({
            budget,
            bucket,
            action,
            model: candidate,
            candidates: skippedForBudget,
            cause: lastError ?? undefined,
          });
        }
        continue;
      }

      const now = this.now();
      if (this.isCoolingDown(candidate, now)) {
        fallbackLog.push({
          from_model: candidate,
          to_model: this.nextCandidate(chain, index + 1, attempts, now),
          reason: `circuit_open cooldown: ${candidate} unavailable`,
          abandoned_cost_usd: 0,
        });
        continue;
      }

      attempts.push(candidate);
      try {
        const response = await invokeWithLatencyLimit(this.clientFn, candidate, rest, thresholdMs);
        // A pure downgrade never called the over-cap primary. Provider failover
        // (attempts after the first) stays a failover, not a budget action.
        const downgraded = skippedForBudget.length > 0 && attempts.length === 1;
        return {
          response,
          meta: applyUsageCost(
            metaFor(candidate, { autoRouted: true, bucket, fallbackLog }),
            {
              model: candidate,
              response,
              inputTokens,
              completionTokens,
              providerCosts: this.config.provider_costs,
              budgetAction: downgraded ? 'DOWNGRADE' : null,
              budgetFromModel: downgraded ? skippedForBudget[0].model : null,
              budgetSkipped: downgraded ? skippedForBudget : null,
            },
          ),
        };
      } catch (err) {
        if (classifyFailure(err) !== 'retryable') throw err;
        lastError = err;
        const failedAt = this.now();
        this.openCircuit(candidate, failedAt);
        fallbackLog.push({
          from_model: candidate,
          to_model: this.nextCandidate(chain, index + 1, attempts, this.now()),
          reason: failoverReason(err),
          abandoned_cost_usd: abandonedCostUsd(this.config, candidate, err),
        });
      }
    }

    if (attempts.length === 0 && skippedForBudget.length > 0) {
      const affordable = chain.some((entry) => entry && !isOverBudget(costOf(entry), budget));
      if (!affordable) {
        raiseBudgetExceeded({
          budget,
          bucket,
          action,
          model: skippedForBudget[0].model,
          candidates: skippedForBudget,
          cause: lastError ?? undefined,
        });
      }
    }

    throw new AllProvidersFailedError(`All providers failed for bucket ${bucket}`, {
      attempts,
      fallback_log: fallbackLog,
      cause: lastError ?? undefined,
    });
  }
}
