// sigil/relay/v1/model-router.test.mjs
// ACT-02 / issue #49: multi-model auto-routing — A1–A3 activation, B1–B9 buckets,
// C1–C6 dispatch, D1–D6 failover and cooldown, E1–E2 budget enforcement,
// F1–F2 multi-turn cost and structural quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AllProvidersFailedError,
  AutoRouter,
  BudgetExceededError,
  Bucket,
  classifyPrompt,
  createDefaultRouteConfig,
  DEFAULT_EXPECTED_COMPLETION_TOKENS,
  estimatePromptTokens,
  estimateRequestCostUsd,
  resolveExpectedCompletionTokens,
  resolveLatencyThresholdMs,
  scoreQuality,
} from './model-router.mjs';

const MODEL_SOL = 'openai-gpt-6.1-sol';
const MODEL_LUNA = 'openai-gpt-6.1-luna';
const MODEL_SONNET = 'anthropic-claude-sonnet-5.5';
const MODEL_OPUS = 'anthropic-claude-opus-5.5';
const MODEL_HAIKU = 'anthropic-claude-haiku-5.5';
const MODEL_FLASH = 'google-gemini-2.5-flash';

function lockedConfig(overrides = {}) {
  return createDefaultRouteConfig({
    default_model: MODEL_SONNET,
    latency_threshold_ms: 2500,
    cooldown_period_sec: 0.2,
    per_request_budget_usd: 0.08,
    over_budget_action: 'DOWNGRADE',
    dispatch_matrix: {
      [Bucket.STRUCTURED_LOGIC]: [MODEL_SOL, MODEL_LUNA],
      [Bucket.VISUAL_CODE]: [MODEL_SONNET, MODEL_OPUS],
      [Bucket.HIGH_VOLUME_SUMMARIZATION]: [MODEL_FLASH, MODEL_HAIKU],
      [Bucket.DEEP_REASONING]: [MODEL_OPUS, MODEL_SOL],
    },
    provider_costs: {
      [MODEL_SOL]: { input: 0.003, output: 0.012 },
      [MODEL_LUNA]: { input: 0.0002, output: 0.0008 },
      [MODEL_SONNET]: { input: 0.003, output: 0.015 },
      [MODEL_OPUS]: { input: 0.015, output: 0.075 },
      [MODEL_HAIKU]: { input: 0.0008, output: 0.004 },
      [MODEL_FLASH]: { input: 0.0001, output: 0.0004 },
    },
    ...overrides,
  });
}

function defaultResponse(model) {
  return {
    id: `resp-${model}`,
    choices: [{ message: { content: `Output from ${model}` } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function httpError(status, message = `HTTP ${status}`, field = 'status') {
  const err = new Error(message);
  err[field] = status;
  return err;
}

function mockClient(responses = {}) {
  const calls = [];
  const clientFn = async (model, payload) => {
    calls.push({ model, payload });
    const spec = responses[model];
    if (typeof spec === 'function') {
      const result = await spec(model, payload);
      if (result instanceof Error) throw result;
      return result ?? defaultResponse(model);
    }
    if (spec instanceof Error) throw spec;
    return spec ?? defaultResponse(model);
  };
  return { clientFn, calls };
}

function autoPayload(text = 'Compute matrix determinant') {
  return { model: 'auto', messages: [{ role: 'user', content: text }] };
}

// Resolves only if the router fails to abort. The latency tests assert they
// finish well before delayMs, which is the "do not wait out the slow call" check.
function delayUnlessAborted(model, payload, delayMs) {
  const signal = payload?.signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(defaultResponse(model)), delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      reject(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function assertAutoRoutes(text, bucket) {
  assert.equal(classifyPrompt(text), bucket);
  const { clientFn, calls } = mockClient();
  const router = new AutoRouter(lockedConfig(), clientFn);
  const { response, meta } = await router.routeAndExecute({
    model: 'auto',
    messages: [{ role: 'user', content: text }],
  });
  const expectedModel = lockedConfig().dispatch_matrix[bucket][0];
  assert.equal(meta.auto_routed, true);
  assert.equal(meta.bucket, bucket);
  assert.equal(meta.model_used, expectedModel);
  assert.equal(meta.headers['x-router-provider'], expectedModel);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, expectedModel);
  assert.equal(response.id, `resp-${expectedModel}`);
}

test('A1: model auto triggers classifier and routes STRUCTURED_LOGIC to Sol', async () => {
  assert.equal(Bucket.STRUCTURED_LOGIC, 'STRUCTURED_LOGIC');
  const { clientFn, calls } = mockClient();
  const router = new AutoRouter(lockedConfig(), clientFn);
  const { response, meta } = await router.routeAndExecute({
    model: 'auto',
    messages: [{ role: 'user', content: 'Compute matrix determinant' }],
  });
  assert.equal(meta.auto_routed, true);
  assert.equal(meta.bucket, Bucket.STRUCTURED_LOGIC);
  assert.equal(meta.model_used, MODEL_SOL);
  assert.equal(calls[0]?.model, MODEL_SOL);
  assert.equal(response.id, `resp-${MODEL_SOL}`);
  assert.equal(meta.headers['x-router-provider'], MODEL_SOL);
});

test('A2: explicit model bypasses classifier', async () => {
  const { clientFn, calls } = mockClient();
  const router = new AutoRouter(lockedConfig(), clientFn);
  const { meta } = await router.routeAndExecute({
    model: MODEL_SONNET,
    messages: [{ role: 'user', content: 'Calculate 2+2' }],
  });
  assert.equal(meta.auto_routed, false);
  assert.equal(meta.bucket, null);
  assert.equal(meta.model_used, MODEL_SONNET);
  assert.equal(calls[0]?.model, MODEL_SONNET);
  assert.ok(meta.headers['x-router-provider']);
  assert.equal(meta.headers['x-router-provider'], MODEL_SONNET);
});

test('A3: missing model uses default without auto-routing', async () => {
  const config = lockedConfig();
  const { clientFn, calls } = mockClient();
  const router = new AutoRouter(config, clientFn);
  const { meta } = await router.routeAndExecute({
    messages: [{ role: 'user', content: 'Calculate 2+2' }],
  });
  assert.equal(meta.auto_routed, false);
  assert.equal(meta.bucket, null);
  assert.equal(meta.model_used, config.default_model);
  assert.equal(calls[0]?.model, MODEL_SONNET);
  assert.ok(meta.headers['x-router-provider']);
  assert.equal(meta.headers['x-router-provider'], MODEL_SONNET);
});

test('B1: math, logic, spreadsheet, and tabular prompts route to STRUCTURED_LOGIC', async () => {
  const prompts = [
    'Compute matrix determinant',
    'Calculate 2+2',
    'Analyze this CSV column',
    'Prove this formula',
  ];
  for (const text of prompts) await assertAutoRoutes(text, Bucket.STRUCTURED_LOGIC);
  // Equal keyword hits: formula (structured) and analyze (deep). Structured wins the tie.
  assert.equal(classifyPrompt('Analyze this formula'), Bucket.STRUCTURED_LOGIC);
});

test('B2: UI, layout, screenshot, and rendering prompts route to VISUAL_CODE', async () => {
  const prompts = [
    'Responsive navbar menu using Tailwind flex',
    'Fix this SVG icon layout',
    'Screenshot of the login page looks broken',
  ];
  for (const text of prompts) await assertAutoRoutes(text, Bucket.VISUAL_CODE);
  // Whole-word visual terms must not treat "review" or "overview" as UI words.
  assert.notEqual(classifyPrompt('Review these 30 tickets'), Bucket.VISUAL_CODE);
  assert.notEqual(classifyPrompt('Give an overview of the quarterly goals'), Bucket.VISUAL_CODE);
  assert.equal(classifyPrompt('Give an overview of the quarterly goals'), Bucket.HIGH_VOLUME_SUMMARIZATION);
});

test('B3: bulk summarize, sweep, and background prompts route to HIGH_VOLUME_SUMMARIZATION', async () => {
  const prompts = [
    'Summarize these 200 support tickets',
    "Batch-summarize yesterday's logs",
    'Sweep inbox and draft short replies',
  ];
  for (const text of prompts) await assertAutoRoutes(text, Bucket.HIGH_VOLUME_SUMMARIZATION);
  assert.equal(classifyPrompt('Review these 30 tickets'), Bucket.HIGH_VOLUME_SUMMARIZATION);
});

test('B4: multi-step analysis and planning prompts route to DEEP_REASONING', async () => {
  const prompts = [
    'Architect a multi-phase cloud migration with trade-offs',
    'Step-by-step risk mitigation strategy for a corporate spinoff',
    'Synthesize contradictory clinical trial results into a plan',
  ];
  for (const text of prompts) await assertAutoRoutes(text, Bucket.DEEP_REASONING);
});

test('B5: an image or file attachment pushes analytical text to VISUAL_CODE', async () => {
  const text = 'Carefully analyze the structural failure mechanics of this beam distribution';
  assert.equal(classifyPrompt(text), Bucket.DEEP_REASONING);

  assert.equal(classifyPrompt(text, {
    attachments: [{ filename: 'beam-report.pdf' }],
  }), Bucket.VISUAL_CODE);
  assert.equal(classifyPrompt(text, {
    attachments: [{ type: 'image', url: 'beam.png' }],
  }), Bucket.VISUAL_CODE);
  assert.equal(classifyPrompt(text, {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image', url: 'beam.png' },
      ],
    }],
  }), Bucket.VISUAL_CODE);

  const { clientFn, calls } = mockClient();
  const router = new AutoRouter(lockedConfig(), clientFn);
  const { meta } = await router.routeAndExecute({
    model: 'auto',
    attachments: [{ type: 'image', url: 'beam.png' }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: 'https://example.test/beam.png' } },
      ],
    }],
  });
  assert.equal(meta.auto_routed, true);
  assert.equal(meta.bucket, Bucket.VISUAL_CODE);
  assert.equal(meta.model_used, MODEL_SONNET);
  assert.equal(meta.headers['x-router-provider'], MODEL_SONNET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, MODEL_SONNET);
});

test('B6: empty, ambiguous, or mixed prompts default to HIGH_VOLUME_SUMMARIZATION and do not throw', async () => {
  assert.doesNotThrow(() => classifyPrompt());
  assert.doesNotThrow(() => classifyPrompt(''));
  assert.doesNotThrow(() => classifyPrompt('Hello'));
  assert.equal(classifyPrompt(), Bucket.HIGH_VOLUME_SUMMARIZATION);
  assert.equal(classifyPrompt(''), Bucket.HIGH_VOLUME_SUMMARIZATION);
  assert.equal(classifyPrompt('   \n\t'), Bucket.HIGH_VOLUME_SUMMARIZATION);
  assert.equal(classifyPrompt('Hello'), Bucket.HIGH_VOLUME_SUMMARIZATION);
  // One visual hit and one deep hit: mixed, so the documented default wins.
  assert.equal(classifyPrompt('SVG migration'), Bucket.HIGH_VOLUME_SUMMARIZATION);

  const { clientFn, calls } = mockClient();
  const router = new AutoRouter(lockedConfig(), clientFn);
  const { meta } = await router.routeAndExecute({
    model: 'auto',
    messages: [{ role: 'user', content: '' }],
  });
  assert.equal(meta.bucket, Bucket.HIGH_VOLUME_SUMMARIZATION);
  assert.equal(meta.model_used, MODEL_FLASH);
  assert.equal(calls.length, 1);
});

test('B7: the same input always yields the same bucket', async () => {
  const samples = [
    ['Compute matrix determinant', undefined],
    ['Hello', undefined],
    ['', undefined],
    ['Architect a multi-phase cloud migration with trade-offs', undefined],
    ['Carefully analyze the structural failure mechanics of this beam distribution', { attachments: [{ type: 'image' }] }],
  ];
  for (const [text, extras] of samples) {
    assert.equal(classifyPrompt(text, extras), classifyPrompt(text, extras));
  }

  const { clientFn } = mockClient();
  const router = new AutoRouter(lockedConfig(), clientFn);
  const payload = { model: 'auto', messages: [{ role: 'user', content: 'Hello' }] };
  const first = await router.routeAndExecute(payload);
  const second = await router.routeAndExecute(payload);
  assert.equal(first.meta.bucket, second.meta.bucket);
  assert.equal(first.meta.bucket, Bucket.HIGH_VOLUME_SUMMARIZATION);
  assert.equal(first.meta.model_used, second.meta.model_used);
});

test('B8: classification makes no client or network call', async () => {
  let classifySideCalls = 0;
  const exploding = async () => {
    classifySideCalls += 1;
    throw new Error('clientFn must not run during classification');
  };
  assert.equal(classifyPrompt('Prove this formula', { clientFn: exploding }), Bucket.STRUCTURED_LOGIC);
  assert.equal(classifyPrompt('Hello', { clientFn: exploding }), Bucket.HIGH_VOLUME_SUMMARIZATION);
  assert.equal(classifySideCalls, 0);

  const events = [];
  const clientFn = async (model) => {
    events.push(model);
    return {
      id: `resp-${model}`,
      choices: [{ message: { content: `Output from ${model}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  };
  const router = new AutoRouter(lockedConfig(), clientFn);
  const { meta } = await router.routeAndExecute({
    model: 'auto',
    messages: [{ role: 'user', content: 'Prove this formula' }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0], MODEL_SOL);
  assert.equal(meta.bucket, Bucket.STRUCTURED_LOGIC);
  assert.equal(meta.model_used, MODEL_SOL);
});

test('B9: held-out fixture accuracy is at least 80%', () => {
  // Tuning strings from B1–B4. Fixtures below must be different sentences.
  const tuningPrompts = new Set([
    'Compute matrix determinant',
    'Calculate 2+2',
    'Analyze this CSV column',
    'Prove this formula',
    'Responsive navbar menu using Tailwind flex',
    'Fix this SVG icon layout',
    'Screenshot of the login page looks broken',
    'Summarize these 200 support tickets',
    "Batch-summarize yesterday's logs",
    'Sweep inbox and draft short replies',
    'Architect a multi-phase cloud migration with trade-offs',
    'Step-by-step risk mitigation strategy for a corporate spinoff',
    'Synthesize contradictory clinical trial results into a plan',
  ]);

  const fixtures = [
    { bucket: Bucket.STRUCTURED_LOGIC, text: 'Calculate the determinant of a larger matrix by cofactor expansion' },
    { bucket: Bucket.STRUCTURED_LOGIC, text: 'Compute the result of 18 / 3 using integer arithmetic logic' },
    { bucket: Bucket.STRUCTURED_LOGIC, text: 'Prove that the spreadsheet formula copies down the column correctly' },
    { bucket: Bucket.STRUCTURED_LOGIC, text: 'Calculate each csv cell after the column filter is applied' },
    { bucket: Bucket.STRUCTURED_LOGIC, text: 'Use equation logic to compute the missing tabular total' },
    { bucket: Bucket.VISUAL_CODE, text: 'Make the navbar responsive with a flex row and a compact menu layout' },
    { bucket: Bucket.VISUAL_CODE, text: 'The screenshot shows the icon clipped outside the svg frame' },
    { bucket: Bucket.VISUAL_CODE, text: 'Rendering the page layout breaks the hero image on a narrow screen' },
    { bucket: Bucket.VISUAL_CODE, text: 'Apply tailwind to the responsive navbar so the flex gaps stay even' },
    { bucket: Bucket.VISUAL_CODE, text: 'UI rendering clips the svg icon when the layout width shrinks' },
    { bucket: Bucket.HIGH_VOLUME_SUMMARIZATION, text: 'Summarize the batch of inbox notes from the weekend shift' },
    { bucket: Bucket.HIGH_VOLUME_SUMMARIZATION, text: "Sweep yesterday's logs and keep only the failing rows" },
    { bucket: Bucket.HIGH_VOLUME_SUMMARIZATION, text: 'Run a background sweep across the ticket logs' },
    { bucket: Bucket.HIGH_VOLUME_SUMMARIZATION, text: 'Bulk summarize the open support tickets before standup' },
    { bucket: Bucket.HIGH_VOLUME_SUMMARIZATION, text: 'Write a short summary of the inbox after the nightly batch' },
    { bucket: Bucket.DEEP_REASONING, text: 'Architect the migration plan around the operational risks' },
    { bucket: Bucket.DEEP_REASONING, text: 'The spinoff needs a mitigation strategy before contracts move' },
    { bucket: Bucket.DEEP_REASONING, text: 'The clinical notes are contradictory and need a single care plan' },
    { bucket: Bucket.DEEP_REASONING, text: 'Weigh the trade-offs of a multi-phase migration' },
    { bucket: Bucket.DEEP_REASONING, text: 'Analyze the second-order risks in this mitigation strategy' },
  ];

  assert.equal(fixtures.length, 20);
  for (const bucket of Object.values(Bucket)) {
    assert.equal(fixtures.filter((fixture) => fixture.bucket === bucket).length, 5);
  }
  for (const fixture of fixtures) {
    assert.equal(tuningPrompts.has(fixture.text), false, fixture.text);
  }

  const misses = [];
  let correct = 0;
  for (const fixture of fixtures) {
    const got = classifyPrompt(fixture.text);
    if (got === fixture.bucket) correct += 1;
    else misses.push(`${JSON.stringify(fixture.text)} → ${got}, want ${fixture.bucket}`);
  }
  const score = correct / fixtures.length;
  assert.ok(score >= 0.8, `accuracy ${correct}/${fixtures.length} = ${score}\n${misses.join('\n')}`);
});

// Locked primaries are index 0 of the configured row. Happy path only; D tests cover failover.
async function assertConfiguredPrimary(text, bucket, row) {
  const [primary] = row;
  const config = lockedConfig();
  assert.deepEqual(config.dispatch_matrix[bucket], row);
  const { clientFn, calls } = mockClient();
  const router = new AutoRouter(config, clientFn);
  const { meta } = await router.routeAndExecute({
    model: 'auto',
    messages: [{ role: 'user', content: text }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, primary);
  assert.equal(calls[0].payload.model, primary);
  assert.equal(calls[0].payload.messages[0].content, text);
  assert.equal(meta.auto_routed, true);
  assert.equal(meta.bucket, bucket);
  assert.equal(meta.model_used, primary);
  assert.equal(meta.headers['x-router-provider'], primary);
  assert.equal(meta.headers['x-router-provider'], meta.model_used);
}

test('C1: STRUCTURED_LOGIC auto prompt dispatches to the Sol primary', async () => {
  await assertConfiguredPrimary(
    'Compute matrix determinant',
    Bucket.STRUCTURED_LOGIC,
    [MODEL_SOL, MODEL_LUNA],
  );
});

test('C2: VISUAL_CODE auto prompt dispatches to the Sonnet primary', async () => {
  await assertConfiguredPrimary(
    'Fix this SVG icon layout',
    Bucket.VISUAL_CODE,
    [MODEL_SONNET, MODEL_OPUS],
  );
});

test('C3: HIGH_VOLUME_SUMMARIZATION auto prompt dispatches to the Flash primary', async () => {
  await assertConfiguredPrimary(
    'Summarize these 200 support tickets',
    Bucket.HIGH_VOLUME_SUMMARIZATION,
    [MODEL_FLASH, MODEL_HAIKU],
  );
});

test('C4: DEEP_REASONING auto prompt dispatches to the Opus primary', async () => {
  await assertConfiguredPrimary(
    'Architect a multi-phase cloud migration with trade-offs',
    Bucket.DEEP_REASONING,
    [MODEL_OPUS, MODEL_SOL],
  );
});

test('C5: dispatch matrix comes from config, not a hardcoded router table', async () => {
  const { clientFn, calls } = mockClient();
  const config = lockedConfig({
    dispatch_matrix: {
      [Bucket.STRUCTURED_LOGIC]: ['test-model-alpha', 'test-model-beta'],
    },
  });
  assert.deepEqual(
    config.dispatch_matrix[Bucket.STRUCTURED_LOGIC],
    ['test-model-alpha', 'test-model-beta'],
  );
  const router = new AutoRouter(config, clientFn);
  const { meta } = await router.routeAndExecute({
    model: 'auto',
    messages: [{ role: 'user', content: 'Compute matrix determinant' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'test-model-alpha');
  assert.equal(calls[0].payload.model, 'test-model-alpha');
  assert.equal(meta.auto_routed, true);
  assert.equal(meta.bucket, Bucket.STRUCTURED_LOGIC);
  assert.equal(meta.model_used, 'test-model-alpha');
  assert.equal(meta.headers['x-router-provider'], 'test-model-alpha');
  assert.equal(meta.headers['x-router-provider'], meta.model_used);
});

test('C6: auto, explicit, and missing-model responses record bucket and provider', async () => {
  const config = lockedConfig();
  const autoText = 'Compute matrix determinant';
  const cases = [
    {
      name: 'auto',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: autoText }],
      },
      autoRouted: true,
      bucket: classifyPrompt(autoText),
      model: MODEL_SOL,
    },
    {
      name: 'explicit',
      payload: {
        model: MODEL_LUNA,
        messages: [{ role: 'user', content: 'Calculate 2+2' }],
      },
      autoRouted: false,
      bucket: null,
      model: MODEL_LUNA,
    },
    {
      name: 'default',
      payload: {
        messages: [{ role: 'user', content: 'Summarize these 200 support tickets' }],
      },
      autoRouted: false,
      bucket: null,
      model: config.default_model,
    },
  ];
  assert.equal(cases[0].bucket, Bucket.STRUCTURED_LOGIC);
  assert.equal(cases[2].model, MODEL_SONNET);

  for (const entry of cases) {
    const { clientFn, calls } = mockClient();
    const router = new AutoRouter(config, clientFn);
    const { meta } = await router.routeAndExecute(entry.payload);
    assert.ok(meta.model_used, entry.name);
    assert.equal(meta.model_used, entry.model, entry.name);
    assert.equal(meta.headers['x-router-provider'], meta.model_used, entry.name);
    assert.equal(meta.auto_routed, entry.autoRouted, entry.name);
    assert.equal(meta.bucket, entry.bucket, entry.name);
    assert.equal(calls.length, 1, entry.name);
    assert.equal(calls[0].model, entry.model, entry.name);
  }
});

test('D1: primary 429 fails over to the next model in the chain', async () => {
  const throttled = httpError(429, 'throttled');
  throttled.usage = { prompt_tokens: 1000, completion_tokens: 1000 };
  const config = lockedConfig();
  const { clientFn, calls } = mockClient({ [MODEL_SOL]: throttled });
  const router = new AutoRouter(config, clientFn);
  const { response, meta } = await router.routeAndExecute(autoPayload('Compute matrix determinant'));
  assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL, MODEL_LUNA]);
  assert.equal(meta.auto_routed, true);
  assert.equal(meta.bucket, Bucket.STRUCTURED_LOGIC);
  assert.equal(meta.model_used, MODEL_LUNA);
  assert.equal(meta.headers['x-router-provider'], MODEL_LUNA);
  assert.equal(response.id, `resp-${MODEL_LUNA}`);
  assert.equal(meta.fallback_log.length, 1);
  const entry = meta.fallback_log[0];
  assert.equal(entry.from_model, MODEL_SOL);
  assert.equal(entry.to_model, MODEL_LUNA);
  assert.match(entry.reason, /429/);
  assert.match(entry.reason, /throttle/i);
  const costs = config.provider_costs[MODEL_SOL];
  const expectedCost = costs.input + costs.output;
  assert.ok(Math.abs(entry.abandoned_cost_usd - expectedCost) < 1e-12);

  const explicit = mockClient({ [MODEL_SOL]: httpError(429, 'throttled') });
  const pinned = new AutoRouter(lockedConfig(), explicit.clientFn);
  await assert.rejects(
    () => pinned.routeAndExecute({
      model: MODEL_SOL,
      messages: [{ role: 'user', content: 'Compute matrix determinant' }],
    }),
    (err) => err.status === 429,
  );
  assert.deepEqual(explicit.calls.map((call) => call.model), [MODEL_SOL]);
});

test('D2: latency over threshold aborts the primary and falls back', async () => {
  const config = lockedConfig({ latency_threshold_ms: 40, cooldown_period_sec: 30 });
  const slowMs = 5000;
  const { clientFn, calls } = mockClient({
    [MODEL_SOL]: (model, payload) => delayUnlessAborted(model, payload, slowMs),
  });
  const router = new AutoRouter(config, clientFn);
  const started = Date.now();
  const { meta } = await router.routeAndExecute(autoPayload('Compute matrix determinant'));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `waited ${elapsed}ms for a ${slowMs}ms primary`);
  assert.equal(calls[0].payload.signal.aborted, true);
  assert.equal(calls[1].payload.signal.aborted, false);
  assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL, MODEL_LUNA]);
  assert.equal(meta.model_used, MODEL_LUNA);
  assert.equal(meta.headers['x-router-provider'], MODEL_LUNA);
  assert.equal(meta.fallback_log.length, 1);
  const entry = meta.fallback_log[0];
  assert.equal(entry.from_model, MODEL_SOL);
  assert.equal(entry.to_model, MODEL_LUNA);
  assert.match(entry.reason, /latency|timeout/i);
  assert.equal(typeof entry.abandoned_cost_usd, 'number');
  assert.ok(entry.abandoned_cost_usd >= 0);

  calls.length = 0;
  const cooled = await router.routeAndExecute(autoPayload('Calculate 2+2'));
  assert.deepEqual(calls.map((call) => call.model), [MODEL_LUNA]);
  assert.equal(cooled.meta.model_used, MODEL_LUNA);
  assert.match(cooled.meta.fallback_log[0].reason, /cooldown/i);

  assert.equal(resolveLatencyThresholdMs(lockedConfig(), Bucket.DEEP_REASONING), 8000);
  assert.equal(resolveLatencyThresholdMs(lockedConfig(), Bucket.STRUCTURED_LOGIC), 2500);
  assert.equal(
    resolveLatencyThresholdMs(lockedConfig({ deep_latency_threshold_ms: 1234 }), Bucket.DEEP_REASONING),
    1234,
  );
});

test('D2: DEEP_REASONING honors deep_latency_threshold_ms', async () => {
  const config = lockedConfig({ deep_latency_threshold_ms: 40, latency_threshold_ms: 2500 });
  const { clientFn, calls } = mockClient({
    [MODEL_OPUS]: (model, payload) => delayUnlessAborted(model, payload, 5000),
  });
  const router = new AutoRouter(config, clientFn);
  const started = Date.now();
  const { meta } = await router.routeAndExecute(autoPayload(
    'Architect a multi-phase cloud migration with trade-offs',
  ));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `deep primary was not aborted (${elapsed}ms)`);
  assert.equal(meta.bucket, Bucket.DEEP_REASONING);
  assert.equal(meta.model_used, MODEL_SOL);
  assert.equal(meta.headers['x-router-provider'], MODEL_SOL);
  assert.deepEqual(calls.map((call) => call.model), [MODEL_OPUS, MODEL_SOL]);
  assert.match(meta.fallback_log[0].reason, /latency|timeout/i);
  assert.equal(calls[0].payload.signal.aborted, true);
});

test('D3: 5xx, 408, and connection errors fall back to the next provider', async () => {
  const cases = [
    { name: '500', error: httpError(500) },
    { name: '503', error: httpError(503) },
    { name: '408', error: httpError(408, 'request timeout') },
    { name: 'ECONNRESET', error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
  ];
  for (const entry of cases) {
    const { clientFn, calls } = mockClient({ [MODEL_SOL]: entry.error });
    const router = new AutoRouter(lockedConfig(), clientFn);
    const { meta } = await router.routeAndExecute(autoPayload('Compute matrix determinant'));
    assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL, MODEL_LUNA], entry.name);
    assert.equal(meta.model_used, MODEL_LUNA, entry.name);
    assert.equal(meta.headers['x-router-provider'], MODEL_LUNA, entry.name);
    assert.equal(meta.fallback_log.length, 1, entry.name);
    assert.equal(meta.fallback_log[0].from_model, MODEL_SOL, entry.name);
    assert.equal(meta.fallback_log[0].to_model, MODEL_LUNA, entry.name);
    if (entry.name === 'ECONNRESET') assert.match(meta.fallback_log[0].reason, /ECONNRESET|connection|timeout/i);
    else assert.match(meta.fallback_log[0].reason, new RegExp(entry.name));
  }
});

test('D3: client errors 400, 401, 403, 404, and 422 fail fast without fallback', async () => {
  const cases = [
    { status: 400, field: 'status' },
    { status: 401, field: 'statusCode' },
    { status: 403, field: 'status' },
    { status: 404, field: 'statusCode' },
    { status: 422, field: 'status' },
  ];
  for (const entry of cases) {
    const { clientFn, calls } = mockClient({
      [MODEL_SOL]: httpError(entry.status, `client ${entry.status}`, entry.field),
    });
    const router = new AutoRouter(lockedConfig(), clientFn);
    await assert.rejects(
      () => router.routeAndExecute(autoPayload('Compute matrix determinant')),
      (err) => {
        assert.equal(err[entry.field], entry.status);
        return true;
      },
    );
    assert.equal(calls.length, 1, String(entry.status));
    assert.equal(calls[0].model, MODEL_SOL, String(entry.status));
  }

  let solCalls = 0;
  const { clientFn, calls } = mockClient({
    [MODEL_SOL]: () => {
      solCalls += 1;
      if (solCalls === 1) throw httpError(400, 'bad request');
      return defaultResponse(MODEL_SOL);
    },
  });
  const router = new AutoRouter(lockedConfig(), clientFn);
  await assert.rejects(() => router.routeAndExecute(autoPayload()));
  calls.length = 0;
  const second = await router.routeAndExecute(autoPayload('Calculate 2+2'));
  assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL]);
  assert.equal(second.meta.model_used, MODEL_SOL);
  assert.equal(second.meta.fallback_log.length, 0);
});

test('D4: every provider failing retryably raises AllProvidersFailedError once each', async () => {
  const config = lockedConfig({
    dispatch_matrix: {
      [Bucket.STRUCTURED_LOGIC]: [MODEL_SOL, MODEL_LUNA, MODEL_SOL],
    },
  });
  const { clientFn, calls } = mockClient({
    [MODEL_SOL]: httpError(429, 'throttled'),
    [MODEL_LUNA]: httpError(503, 'unavailable'),
  });
  const router = new AutoRouter(config, clientFn);
  await assert.rejects(
    () => router.routeAndExecute(autoPayload('Compute matrix determinant')),
    (err) => {
      assert.ok(err instanceof AllProvidersFailedError);
      assert.equal(err.name, 'AllProvidersFailedError');
      assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
      assert.match(err.message, /All providers failed/);
      assert.deepEqual(err.attempts, [MODEL_SOL, MODEL_LUNA]);
      assert.equal(err.fallback_log.length, 2);
      assert.match(err.fallback_log[0].reason, /429/);
      assert.match(err.fallback_log[1].reason, /503/);
      return true;
    },
  );
  assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL, MODEL_LUNA]);
});

test('D5: each failover is logged and the final provider is the one that served', async () => {
  const alpha = 'test-model-alpha';
  const beta = 'test-model-beta';
  const gamma = 'test-model-gamma';
  const config = lockedConfig({
    dispatch_matrix: {
      [Bucket.STRUCTURED_LOGIC]: [alpha, beta, gamma],
    },
    provider_costs: {
      [alpha]: { input: 0.003, output: 0.012 },
      [beta]: { input: 0.0002, output: 0.0008 },
      [gamma]: { input: 0.0001, output: 0.0004 },
    },
  });
  const betaError = httpError(503, 'unavailable');
  betaError.usage = { prompt_tokens: 0, completion_tokens: 0 };
  const { clientFn, calls } = mockClient({
    [alpha]: httpError(429, 'throttled'),
    [beta]: betaError,
  });
  const router = new AutoRouter(config, clientFn);
  const { response, meta } = await router.routeAndExecute(autoPayload('Compute matrix determinant'));
  assert.deepEqual(calls.map((call) => call.model), [alpha, beta, gamma]);
  assert.equal(meta.model_used, gamma);
  assert.equal(meta.headers['x-router-provider'], gamma);
  assert.equal(meta.headers['x-router-provider'], meta.model_used);
  assert.equal(response.id, `resp-${gamma}`);
  assert.equal(meta.fallback_log.length, 2);
  assert.deepEqual(
    meta.fallback_log.map((entry) => entry.from_model),
    [alpha, beta],
  );
  assert.deepEqual(
    meta.fallback_log.map((entry) => entry.to_model),
    [beta, gamma],
  );
  assert.match(meta.fallback_log[0].reason, /429|throttle/i);
  assert.match(meta.fallback_log[1].reason, /503/);
  for (const entry of meta.fallback_log) {
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length > 0);
    assert.equal(typeof entry.abandoned_cost_usd, 'number');
    assert.ok(entry.abandoned_cost_usd >= 0);
  }
  assert.equal(meta.fallback_log[1].abandoned_cost_usd, 0);
});

test('D6: a throttled provider recovers after cooldown', async () => {
  let now = 10_000;
  let solCalls = 0;
  const { clientFn, calls } = mockClient({
    [MODEL_SOL]: () => {
      solCalls += 1;
      if (solCalls === 1) throw httpError(429, 'throttled');
      return defaultResponse(MODEL_SOL);
    },
  });
  const router = new AutoRouter(lockedConfig(), clientFn, { now: () => now });
  const first = await router.routeAndExecute(autoPayload('Compute matrix determinant'));
  assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL, MODEL_LUNA]);
  assert.equal(first.meta.model_used, MODEL_LUNA);
  assert.match(first.meta.fallback_log[0].reason, /429|throttle/i);

  calls.length = 0;
  const second = await router.routeAndExecute(autoPayload('Compute matrix determinant'));
  assert.deepEqual(calls.map((call) => call.model), [MODEL_LUNA]);
  assert.equal(second.meta.model_used, MODEL_LUNA);
  assert.equal(second.meta.headers['x-router-provider'], MODEL_LUNA);
  assert.equal(second.meta.fallback_log.length, 1);
  assert.equal(second.meta.fallback_log[0].from_model, MODEL_SOL);
  assert.equal(second.meta.fallback_log[0].to_model, MODEL_LUNA);
  assert.match(second.meta.fallback_log[0].reason, /cooldown/i);
  assert.equal(typeof second.meta.fallback_log[0].abandoned_cost_usd, 'number');

  now += lockedConfig().cooldown_period_sec * 1000;
  calls.length = 0;
  const third = await router.routeAndExecute(autoPayload('Calculate 2+2'));
  assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL]);
  assert.equal(third.meta.model_used, MODEL_SOL);
  assert.equal(third.meta.headers['x-router-provider'], MODEL_SOL);
  assert.equal(third.meta.fallback_log.length, 0);
  assert.equal(third.response.id, `resp-${MODEL_SOL}`);
});

function assertCloseUsd(actual, expected) {
  assert.equal(typeof actual, 'number');
  assert.ok(Number.isFinite(actual), String(actual));
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
}

function budgetedPromptEstimate(text, model, config) {
  const inputTokens = estimatePromptTokens(text);
  const completionTokens = resolveExpectedCompletionTokens(config);
  return {
    inputTokens,
    completionTokens,
    estimated_cost_usd: estimateRequestCostUsd(model, inputTokens, completionTokens, config.provider_costs),
  };
}

test('E1: budget downgrade then reject if still over', async () => {
  const text = 'Compute matrix determinant';
  assert.equal(estimatePromptTokens(''), 0);
  assert.equal(estimatePromptTokens('   '), 0);
  assert.equal(estimatePromptTokens('abcd'), 1);
  assert.equal(estimatePromptTokens('abcde'), 2);
  assert.equal(estimatePromptTokens(text), Math.ceil(text.trim().length / 4));
  assert.equal(
    estimateRequestCostUsd('priced', 2500, 1250, { priced: { input: 3, output: 9 } }),
    (2500 / 1000) * 3 + (1250 / 1000) * 9,
  );
  assert.equal(estimateRequestCostUsd('unpriced', 100, 100, {}), 0);

  const base = lockedConfig();
  const solPre = budgetedPromptEstimate(text, MODEL_SOL, base);
  const lunaPre = budgetedPromptEstimate(text, MODEL_LUNA, base);
  assert.equal(solPre.completionTokens, DEFAULT_EXPECTED_COMPLETION_TOKENS);
  assert.ok(lunaPre.estimated_cost_usd > 0);
  assert.ok(solPre.estimated_cost_usd > lunaPre.estimated_cost_usd);
  const between = (solPre.estimated_cost_usd + lunaPre.estimated_cost_usd) / 2;
  assert.ok(solPre.estimated_cost_usd > between);
  assert.ok(lunaPre.estimated_cost_usd <= between);

  // Case A — primary Sol is over the cap, Luna fits, so the client sees Luna only.
  {
    const usage = { prompt_tokens: 12, completion_tokens: 4 };
    const { clientFn, calls } = mockClient({
      [MODEL_LUNA]: {
        id: `resp-${MODEL_LUNA}`,
        choices: [{ message: { content: 'ok' } }],
        usage,
      },
    });
    const config = lockedConfig({ per_request_budget_usd: between });
    const router = new AutoRouter(config, clientFn);
    const { response, meta } = await router.routeAndExecute(autoPayload(text));
    assert.deepEqual(calls.map((call) => call.model), [MODEL_LUNA]);
    assert.equal(calls[0].payload.model, MODEL_LUNA);
    assert.equal(calls[0].payload.messages[0].content, text);
    assert.equal(response.id, `resp-${MODEL_LUNA}`);
    assert.equal(meta.auto_routed, true);
    assert.equal(meta.bucket, Bucket.STRUCTURED_LOGIC);
    assert.equal(meta.model_used, MODEL_LUNA);
    assert.equal(meta.budget_action, 'DOWNGRADE');
    assert.equal(meta.budget_from_model, MODEL_SOL);
    assert.equal(meta.headers['x-router-provider'], MODEL_LUNA);
    assert.equal(meta.headers['x-router-provider'], meta.model_used);
    assert.equal(meta.fallback_log.length, 0);
    const usageCost = estimateRequestCostUsd(
      MODEL_LUNA,
      usage.prompt_tokens,
      usage.completion_tokens,
      config.provider_costs,
    );
    assertCloseUsd(meta.estimated_cost_usd, usageCost);
    assert.ok(meta.estimated_cost_usd <= config.per_request_budget_usd);
    assert.ok(Math.abs(usageCost - lunaPre.estimated_cost_usd) > 1e-8);
  }

  // Case B — both Sol and Luna estimates exceed the cap. Pre-check only.
  {
    const giant = `Compute matrix determinant ${'x'.repeat(20_000)}`;
    assert.equal(classifyPrompt(giant), Bucket.STRUCTURED_LOGIC);
    const tight = 1e-9;
    const config = lockedConfig({ per_request_budget_usd: tight });
    const giantSol = budgetedPromptEstimate(giant, MODEL_SOL, config);
    const giantLuna = budgetedPromptEstimate(giant, MODEL_LUNA, config);
    assert.ok(giantSol.estimated_cost_usd > tight);
    assert.ok(giantLuna.estimated_cost_usd > tight);
    const { clientFn, calls } = mockClient();
    const router = new AutoRouter(config, clientFn);
    await assert.rejects(
      () => router.routeAndExecute(autoPayload(giant)),
      (err) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.ok(err instanceof Error);
        assert.equal(err instanceof AllProvidersFailedError, false);
        assert.equal(err.name, 'BudgetExceededError');
        assert.equal(err.code, 'BUDGET_EXCEEDED');
        assert.match(err.message, /budget/i);
        assert.deepEqual(err.candidates.map((entry) => entry.model), [MODEL_SOL, MODEL_LUNA]);
        assert.ok(err.candidates.every((entry) => entry.estimated_cost_usd > tight));
        return true;
      },
    );
    assert.equal(calls.length, 0);
    // A budget reject is fail-fast: it does not open a provider cooldown.
    router.config = lockedConfig();
    const recovered = await router.routeAndExecute(autoPayload(text));
    assert.deepEqual(calls.map((call) => call.model), [MODEL_SOL]);
    assert.equal(recovered.meta.model_used, MODEL_SOL);
    assert.equal(recovered.meta.budget_action, undefined);
  }

  // Case C — REJECT does not try the cheaper model even when that model would fit.
  {
    const { clientFn, calls } = mockClient();
    const config = lockedConfig({
      per_request_budget_usd: between,
      over_budget_action: 'REJECT',
    });
    const router = new AutoRouter(config, clientFn);
    await assert.rejects(
      () => router.routeAndExecute(autoPayload(text)),
      (err) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.equal(err.code, 'BUDGET_EXCEEDED');
        assert.equal(err.action, 'REJECT');
        assert.deepEqual(err.candidates.map((entry) => entry.model), [MODEL_SOL]);
        assertCloseUsd(err.candidates[0].estimated_cost_usd, solPre.estimated_cost_usd);
        assert.match(err.message, /budget/i);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  }

  // Configured downgrade target is used when the bucket chain itself has no model under the cap.
  {
    const { clientFn, calls } = mockClient();
    const config = lockedConfig({
      per_request_budget_usd: between,
      dispatch_matrix: {
        [Bucket.STRUCTURED_LOGIC]: [MODEL_SOL],
      },
      downgrade_targets: { [MODEL_SOL]: MODEL_LUNA },
    });
    const router = new AutoRouter(config, clientFn);
    const { meta } = await router.routeAndExecute(autoPayload(text));
    assert.deepEqual(calls.map((call) => call.model), [MODEL_LUNA]);
    assert.equal(meta.model_used, MODEL_LUNA);
    assert.equal(meta.budget_action, 'DOWNGRADE');
    assert.equal(meta.budget_from_model, MODEL_SOL);
    assert.equal(meta.headers['x-router-provider'], MODEL_LUNA);
    assert.ok(meta.estimated_cost_usd <= between);
  }

  // A pinned model has no bucket chain. Over cap rejects before the client call.
  {
    const { clientFn, calls } = mockClient();
    const config = lockedConfig({ per_request_budget_usd: between });
    const router = new AutoRouter(config, clientFn);
    await assert.rejects(
      () => router.routeAndExecute({
        model: MODEL_SOL,
        messages: [{ role: 'user', content: text }],
      }),
      (err) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.equal(err.code, 'BUDGET_EXCEEDED');
        return true;
      },
    );
    assert.equal(calls.length, 0);
  }
});

test('E2: cost tracked per request from provider token counts', async () => {
  const usage = { prompt_tokens: 1800, completion_tokens: 640 };
  const config = lockedConfig();
  const { clientFn, calls } = mockClient({
    [MODEL_SOL]: {
      id: `resp-${MODEL_SOL}`,
      choices: [{ message: { content: 'ok' } }],
      usage,
    },
  });
  const router = new AutoRouter(config, clientFn);
  const { meta } = await router.routeAndExecute(autoPayload('Compute matrix determinant'));
  const expected = estimateRequestCostUsd(
    MODEL_SOL,
    usage.prompt_tokens,
    usage.completion_tokens,
    config.provider_costs,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, MODEL_SOL);
  assert.equal(meta.model_used, MODEL_SOL);
  assert.equal(meta.auto_routed, true);
  assertCloseUsd(meta.estimated_cost_usd, expected);
  assert.equal(meta.prompt_tokens, usage.prompt_tokens);
  assert.equal(meta.completion_tokens, usage.completion_tokens);
  assert.deepEqual(meta.usage, {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
  });

  const explicitUsage = { prompt_tokens: 50, completion_tokens: 25 };
  const explicit = mockClient({
    [MODEL_LUNA]: {
      id: `resp-${MODEL_LUNA}`,
      choices: [{ message: { content: 'ok' } }],
      usage: explicitUsage,
    },
  });
  const pinned = new AutoRouter(config, explicit.clientFn);
  const pinnedResult = await pinned.routeAndExecute({
    model: MODEL_LUNA,
    messages: [{ role: 'user', content: 'Calculate 2+2' }],
  });
  assert.equal(explicit.calls.length, 1);
  assert.equal(explicit.calls[0].model, MODEL_LUNA);
  assert.equal(pinnedResult.meta.model_used, MODEL_LUNA);
  assert.equal(pinnedResult.meta.auto_routed, false);
  assert.equal(pinnedResult.meta.prompt_tokens, explicitUsage.prompt_tokens);
  assert.equal(pinnedResult.meta.completion_tokens, explicitUsage.completion_tokens);
  assert.deepEqual(pinnedResult.meta.usage, {
    prompt_tokens: explicitUsage.prompt_tokens,
    completion_tokens: explicitUsage.completion_tokens,
  });
  assertCloseUsd(
    pinnedResult.meta.estimated_cost_usd,
    estimateRequestCostUsd(MODEL_LUNA, 50, 25, config.provider_costs),
  );

  const text = 'Compute matrix determinant';
  const custom = lockedConfig({ expected_completion_tokens: 40 });
  const noUsage = mockClient({
    [MODEL_SOL]: {
      id: `resp-${MODEL_SOL}`,
      choices: [{ message: { content: 'ok' } }],
    },
  });
  const fallbackRouter = new AutoRouter(custom, noUsage.clientFn);
  const fallback = await fallbackRouter.routeAndExecute(autoPayload(text));
  const inputTokens = estimatePromptTokens(text);
  assert.equal(fallback.meta.model_used, MODEL_SOL);
  assert.equal(fallback.meta.prompt_tokens, inputTokens);
  assert.equal(fallback.meta.completion_tokens, 40);
  assert.deepEqual(fallback.meta.usage, {
    prompt_tokens: inputTokens,
    completion_tokens: 40,
  });
  assertCloseUsd(
    fallback.meta.estimated_cost_usd,
    estimateRequestCostUsd(MODEL_SOL, inputTokens, 40, custom.provider_costs),
  );
  assert.equal(resolveExpectedCompletionTokens({}), DEFAULT_EXPECTED_COMPLETION_TOKENS);
});

// F1–F2. Four-turn pipeline, one prompt per bucket. The mock returns a recorded
// completion per model. Opus has two recordings because the deep-reasoning
// primary is Opus, the same model the baseline pins: one shared Opus string
// would make that turn compare a document to itself. Cheaper models are thinner
// and miss rubric checks outside the bucket they are built for.
const BENCH_USAGE = { prompt_tokens: 400, completion_tokens: 800 };

const OPUS_BASELINE = [
  '## Result',
  'The determinant of the supplied matrix is 42. Cofactor expansion along the first row produces that integer with no remainder.',
  '',
  '## Formula',
  'Each cofactor is the signed minor of its entry. Summing those products gives the determinant of the matrix.',
  '',
  '{"determinant": 42, "method": "cofactor"}',
  '',
  '## Layout',
  'The responsive navbar uses tailwind spacing so the svg icon stays inside a flex row on a narrow screen.',
  '',
  '## Markup',
  '<svg viewBox="0 0 24 24"></svg>',
  'Keep the navbar responsive and preserve the flex gap when the window shrinks.',
  '',
  '## Summary',
  'The inbox sweep closed the remaining tickets before standup.',
  '- status: reviewed',
  '- count: 200',
  '',
  '## Plan',
  'Run the cloud migration in three phases and record the decision before cutover begins.',
  '',
  '## Trade-offs',
  'A shorter migration window increases operational risk. A longer migration costs more calendar time. Pick the mitigation that keeps data intact.',
  '',
  '## Risks',
  'The mitigation list stays explicit.',
  '- downtime',
  '- rollback',
  '',
  'fixture-id: opus-baseline',
].join('\n');

const OPUS_AUTO = [
  '## Result',
  'Computed determinant equals 7. The cofactor signs alternate across the first row and the total is exact.',
  '',
  '## Formula',
  'Apply a cofactor to every leading entry, then add the signed terms. This determinant matches the manual check.',
  '',
  '{"determinant": 7, "method": "cofactor"}',
  '',
  '## Layout',
  'A compact navbar is styled with tailwind. The svg mark sits on a flex line and remains visible at 320px.',
  '',
  '## Markup',
  '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'Make the navbar responsive. Do not collapse the flex alignment of the icon.',
  '',
  '## Summary',
  'Closed the inbox batch and labeled the open tickets.',
  '- status: reviewed',
  '- count: 200',
  '',
  '## Plan',
  'Describe the migration as separate phases with an owner for each phase.',
  '',
  '## Trade-offs',
  'Cutting migration time saves budget and raises failure risk. Spending time on mitigation reduces rework.',
  '',
  '## Risks',
  'Publish the mitigation before the first phase starts.',
  '- downtime',
  '- rollback',
  '',
  'fixture-id: opus-auto',
].join('\n');

const SOL_TEXT = [
  '## Result',
  'The determinant of this matrix is 15. Expansion by minors leaves an integer result and no rounding gap.',
  '',
  '## Formula',
  'Take the cofactor of each first-row entry and add the signed products. The determinant agrees with the hand total.',
  '',
  '{"determinant": 15, "method": "cofactor"}',
  '',
  'fixture-id: sol',
].join('\n');

const SONNET_TEXT = [
  '## Layout',
  'Rebuild the navbar with tailwind so the header stays on one line at desktop width and stacks when the screen is narrow.',
  '',
  '## Markup',
  '<svg viewBox="0 0 24 24"></svg>',
  'The icon sits in a flex group inside the navbar. Keep the bar responsive when the viewport shrinks.',
  '',
  'fixture-id: sonnet',
].join('\n');

const FLASH_TEXT = [
  '## Summary',
  'The inbox batch of open tickets is ready for the morning standup.',
  '- status: reviewed',
  '- count: 200',
  '',
  'fixture-id: flash',
].join('\n');

const LUNA_TEXT = '15\nfixture-id: luna';
const HAIKU_TEXT = 'Noted.\nfixture-id: haiku';

const AUTO_FIXTURES = {
  [MODEL_SOL]: SOL_TEXT,
  [MODEL_LUNA]: LUNA_TEXT,
  [MODEL_SONNET]: SONNET_TEXT,
  [MODEL_OPUS]: OPUS_AUTO,
  [MODEL_HAIKU]: HAIKU_TEXT,
  [MODEL_FLASH]: FLASH_TEXT,
};

const PIPELINE = [
  {
    bucket: Bucket.STRUCTURED_LOGIC,
    prompt: 'Compute the determinant of this matrix with the cofactor formula',
    rubric: {
      sections: ['## Result', '## Formula'],
      requiredTokens: ['determinant', 'cofactor'],
      minLength: 100,
      jsonKeys: ['determinant', 'method'],
    },
  },
  {
    bucket: Bucket.VISUAL_CODE,
    prompt: 'Fix this SVG icon layout in the responsive navbar using Tailwind flex',
    rubric: {
      sections: ['## Layout', '## Markup'],
      requiredTokens: ['navbar', 'tailwind', 'svg'],
      minLength: 70,
      checklist: ['responsive', 'flex'],
    },
  },
  {
    bucket: Bucket.HIGH_VOLUME_SUMMARIZATION,
    prompt: 'Summarize these 200 support tickets from the inbox batch',
    rubric: {
      sections: ['## Summary'],
      requiredTokens: ['inbox', 'tickets'],
      minLength: 60,
      checklist: ['- status: reviewed', '- count: 200'],
    },
  },
  {
    bucket: Bucket.DEEP_REASONING,
    prompt: 'Architect a multi-phase cloud migration with trade-offs and a mitigation plan',
    rubric: {
      sections: ['## Plan', '## Trade-offs', '## Risks'],
      requiredTokens: ['migration', 'mitigation'],
      minLength: 90,
      checklist: ['- downtime', '- rollback'],
    },
  },
];

function benchmarkClient(run) {
  const table = run === 'baseline' ? { [MODEL_OPUS]: OPUS_BASELINE } : AUTO_FIXTURES;
  return async (model) => {
    const content = table[model];
    if (typeof content !== 'string') {
      throw new Error(`benchmark fixture missing for ${run} run model ${model}`);
    }
    return {
      id: `bench-${run}-${model}`,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: BENCH_USAGE.prompt_tokens, completion_tokens: BENCH_USAGE.completion_tokens },
    };
  };
}

function pipelinePayload(run, prompt) {
  const messages = [{ role: 'user', content: prompt }];
  if (run === 'baseline') return { model: MODEL_OPUS, messages };
  return { model: 'auto', messages };
}

async function runBenchmarkPipeline(run) {
  const config = lockedConfig();
  const router = new AutoRouter(config, benchmarkClient(run));
  const turns = [];
  for (const turn of PIPELINE) {
    const { response, meta } = await router.routeAndExecute(pipelinePayload(run, turn.prompt));
    const text = response?.choices?.[0]?.message?.content ?? '';
    turns.push({ ...turn, response, meta, text, cost: meta.estimated_cost_usd });
  }
  return { config, turns };
}

function formatUsd(value) {
  return Number(value).toFixed(6);
}

test('scoreQuality scores structural checks as a fraction', () => {
  const rubric = {
    sections: ['## Result'],
    requiredTokens: ['determinant'],
    minLength: 20,
    jsonKeys: ['method'],
    checklist: ['- done'],
  };
  const full = [
    '## Result',
    'determinant shown',
    '{"method": "cofactor"}',
    '- done',
  ].join('\n');
  const other = [
    '## Result',
    'The determinant is ready',
    '{"method": "expansion"}',
    '- done',
  ].join('\n');
  assert.equal(scoreQuality(full, rubric), 1);
  assert.equal(scoreQuality('## Result\n', rubric), 1 / 5);
  assert.equal(scoreQuality('', rubric), 0);
  assert.equal(scoreQuality('anything', {}), 1);
  assert.equal(scoreQuality('anything', null), 1);
  assert.notEqual(full, other);
  assert.equal(scoreQuality(other, rubric), scoreQuality(full, rubric));
  assert.equal(scoreQuality('no structure here', rubric), 0);
});

test('F1: auto routing cuts multi-turn cost by more than 30% versus always-Opus', async () => {
  const config = lockedConfig();
  for (const turn of PIPELINE) {
    assert.equal(classifyPrompt(turn.prompt), turn.bucket, turn.prompt);
    assert.equal(config.dispatch_matrix[turn.bucket][0] != null, true, turn.bucket);
  }

  const baseline = await runBenchmarkPipeline('baseline');
  const auto = await runBenchmarkPipeline('auto');
  assert.equal(baseline.turns.length, 4);
  assert.equal(auto.turns.length, 4);

  const rows = [];
  let baselineTotal = 0;
  let autoTotal = 0;
  for (let index = 0; index < PIPELINE.length; index += 1) {
    const baseTurn = baseline.turns[index];
    const autoTurn = auto.turns[index];
    const primary = config.dispatch_matrix[baseTurn.bucket][0];
    assert.equal(baseTurn.meta.model_used, MODEL_OPUS, baseTurn.bucket);
    assert.equal(baseTurn.meta.auto_routed, false, baseTurn.bucket);
    assert.equal(baseTurn.meta.bucket, null, baseTurn.bucket);
    assert.equal(autoTurn.meta.auto_routed, true, autoTurn.bucket);
    assert.equal(autoTurn.meta.bucket, autoTurn.bucket, autoTurn.bucket);
    assert.equal(autoTurn.meta.model_used, primary, autoTurn.bucket);
    assert.equal(autoTurn.meta.headers['x-router-provider'], primary, autoTurn.bucket);
    assert.equal(autoTurn.meta.budget_action, undefined, autoTurn.bucket);
    const baseExpected = estimateRequestCostUsd(
      MODEL_OPUS,
      BENCH_USAGE.prompt_tokens,
      BENCH_USAGE.completion_tokens,
      config.provider_costs,
    );
    const autoExpected = estimateRequestCostUsd(
      primary,
      BENCH_USAGE.prompt_tokens,
      BENCH_USAGE.completion_tokens,
      config.provider_costs,
    );
    assertCloseUsd(baseTurn.cost, baseExpected);
    assertCloseUsd(autoTurn.cost, autoExpected);
    assert.ok(baseTurn.cost > 0, baseTurn.bucket);
    if (primary === MODEL_OPUS) assertCloseUsd(autoTurn.cost, baseTurn.cost);
    else assert.ok(autoTurn.cost < baseTurn.cost, autoTurn.bucket);
    baselineTotal += baseTurn.cost;
    autoTotal += autoTurn.cost;
    rows.push(
      `${baseTurn.bucket}: baseline ${formatUsd(baseTurn.cost)} (${baseTurn.meta.model_used}) auto ${formatUsd(autoTurn.cost)} (${autoTurn.meta.model_used})`,
    );
  }

  const saved = ((baselineTotal - autoTotal) / baselineTotal) * 100;
  assert.ok(
    autoTotal <= baselineTotal * 0.70,
    `F1 expected auto cost <= 70% of baseline (>30% reduction); baseline ${formatUsd(baselineTotal)} USD, auto ${formatUsd(autoTotal)} USD, saved ${saved.toFixed(2)}%. ${rows.join('; ')}`,
  );
});

test('F2: auto quality stays at or above the Opus baseline on a structural rubric', async () => {
  const recorded = [OPUS_BASELINE, OPUS_AUTO, SOL_TEXT, SONNET_TEXT, FLASH_TEXT, LUNA_TEXT, HAIKU_TEXT];
  assert.equal(new Set(recorded).size, recorded.length);
  for (const turn of PIPELINE) {
    assert.equal(scoreQuality(OPUS_BASELINE, turn.rubric), 1, `baseline opus rubric ${turn.bucket}`);
    assert.equal(scoreQuality(OPUS_AUTO, turn.rubric), 1, `auto opus rubric ${turn.bucket}`);
    assert.ok(
      scoreQuality(`Output from ${MODEL_OPUS}`, turn.rubric) < 1,
      turn.bucket,
    );
  }
  assert.equal(scoreQuality(SOL_TEXT, PIPELINE[0].rubric), 1);
  assert.equal(scoreQuality(SONNET_TEXT, PIPELINE[1].rubric), 1);
  assert.equal(scoreQuality(FLASH_TEXT, PIPELINE[2].rubric), 1);
  assert.ok(scoreQuality(LUNA_TEXT, PIPELINE[0].rubric) < scoreQuality(SOL_TEXT, PIPELINE[0].rubric));
  assert.ok(scoreQuality(HAIKU_TEXT, PIPELINE[1].rubric) < scoreQuality(SONNET_TEXT, PIPELINE[1].rubric));
  assert.ok(scoreQuality(LUNA_TEXT, PIPELINE[2].rubric) < scoreQuality(FLASH_TEXT, PIPELINE[2].rubric));
  assert.ok(scoreQuality(FLASH_TEXT, PIPELINE[0].rubric) < 1);
  assert.ok(scoreQuality(FLASH_TEXT, PIPELINE[3].rubric) < scoreQuality(OPUS_AUTO, PIPELINE[3].rubric));
  assert.ok(scoreQuality(HAIKU_TEXT, PIPELINE[3].rubric) < scoreQuality(OPUS_BASELINE, PIPELINE[3].rubric));
  assert.ok(scoreQuality(SOL_TEXT, PIPELINE[1].rubric) < 1);
  assert.ok(scoreQuality(SONNET_TEXT, PIPELINE[2].rubric) < 1);
  assert.ok(scoreQuality(SONNET_TEXT, PIPELINE[3].rubric) < 1);

  const baseline = await runBenchmarkPipeline('baseline');
  const auto = await runBenchmarkPipeline('auto');
  const baselineScores = [];
  const autoScores = [];
  for (let index = 0; index < PIPELINE.length; index += 1) {
    const baseTurn = baseline.turns[index];
    const autoTurn = auto.turns[index];
    const primary = lockedConfig().dispatch_matrix[autoTurn.bucket][0];
    assert.equal(baseTurn.text, OPUS_BASELINE, baseTurn.bucket);
    assert.equal(autoTurn.text, AUTO_FIXTURES[primary], autoTurn.bucket);
    assert.notEqual(baseTurn.text, autoTurn.text, autoTurn.bucket);
    const baseScore = scoreQuality(baseTurn.text, baseTurn.rubric);
    const autoScore = scoreQuality(autoTurn.text, autoTurn.rubric);
    baselineScores.push(baseScore);
    autoScores.push(autoScore);
    assert.ok(
      autoScore >= baseScore,
      `F2 quality loss on ${autoTurn.bucket}: auto ${autoScore} (${autoTurn.meta.model_used}) < baseline ${baseScore} (${baseTurn.meta.model_used})`,
    );
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(autoScores) >= mean(baselineScores));
  assert.equal(auto.turns[3].meta.model_used, MODEL_OPUS);
  assert.equal(baseline.turns[3].meta.model_used, MODEL_OPUS);
  assert.notEqual(auto.turns[0].meta.model_used, MODEL_OPUS);
  assert.notEqual(auto.turns[1].meta.model_used, MODEL_OPUS);
  assert.notEqual(auto.turns[2].meta.model_used, MODEL_OPUS);
});
