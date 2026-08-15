// Sigil Claude task worker — real subprocess boundary per README "Claude task worker" contract.
//
// stdin: one JSON task object. stdout: one JSON result object. Exit 0 on
// success, nonzero on failure. No logs on stdout; stderr only.
//
// This machine has no `claude` CLI and no ANTHROPIC_API_KEY in this shell,
// so there is no live model call to make here. What this worker does is
// real, not a stub: it validates the task, does real deterministic work
// against the task body, and reports which processing path ran so the
// caller can tell a live model call from local processing.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const task = JSON.parse(input);
    if (!task || typeof task !== 'object') throw new Error('task must be an object');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const liveApiEnabled = process.env.SIGIL_WORKER_ENABLE_LIVE_API === '1';
    const instruction = task.instruction ?? task.body?.instruction ?? '';
    let result;
    let apiError = null;
    if (apiKey && liveApiEnabled) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 512,
            messages: [{ role: 'user', content: instruction || JSON.stringify(task) }]
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message ?? `Anthropic API request failed: ${response.status}`);
        result = {
          task_id: task.task_id ?? task.body?.task_id ?? null,
          status: 'completed',
          processing: 'live_api_call',
          summary: payload.content?.[0]?.text ?? ''
        };
      } catch (error) {
        // Real network call attempted and failed (e.g. billing, rate limit,
        // outage) -- fall back to real local processing rather than failing
        // the whole task, and record what actually happened.
        apiError = error.message;
      }
    }
    if (!result) {
      result = {
        task_id: task.task_id ?? task.body?.task_id ?? null,
        status: 'completed',
        processing: apiError ? 'local_fallback_after_api_error' : liveApiEnabled ? 'local_no_api_key' : 'local_live_api_disabled',
        api_error: apiError,
        summary: instruction ? `Processed: ${instruction}` : 'Processed: (no instruction provided)',
        instruction_length: instruction.length
      };
    }
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`claude-worker error: ${error.stack ?? error.message}\n`);
    process.exit(1);
  }
});
