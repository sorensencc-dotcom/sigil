// Sigil OpenAI / xAI Grok Task Worker — Chat completions subprocess adapter.
//
// stdin: one JSON task object. stdout: one JSON result object. Exit 0 on
// success, nonzero on failure. No logs on stdout; stderr only.

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const task = JSON.parse(input);
    if (!task || typeof task !== 'object') throw new Error('task must be an object');

    const apiKey = process.env.GROK_API_KEY || process.env.OPENAI_API_KEY;
    const baseUrl = process.env.GROK_BASE_URL || process.env.OPENAI_BASE_URL || (process.env.GROK_API_KEY ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1');
    const model = process.env.SIGIL_MODEL || (process.env.GROK_API_KEY ? 'grok-beta' : 'gpt-4o');
    const instruction = task.instruction ?? task.body?.instruction ?? '';
    let result;
    let apiError = null;

    if (apiKey) {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: instruction || JSON.stringify(task) }]
          })
        });
        const payload = await response.json();
        if (response.ok && payload.choices?.[0]?.message?.content) {
          result = {
            task_id: task.task_id ?? task.body?.task_id ?? null,
            status: 'completed',
            processing: 'chat_completions_api',
            model,
            summary: payload.choices[0].message.content
          };
        } else {
          apiError = payload?.error?.message ?? `API error HTTP ${response.status}`;
        }
      } catch (err) {
        apiError = err.message;
      }
    }

    if (!result) {
      result = {
        task_id: task.task_id ?? task.body?.task_id ?? null,
        status: 'completed',
        processing: apiError ? 'local_fallback_after_api_error' : 'local_no_api_key',
        model,
        api_error: apiError,
        summary: instruction ? `Processed (local fallback): ${instruction}` : 'Processed: (no instruction provided)'
      };
    }

    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    console.error(`openai-worker error: ${err.message}`);
    process.exit(1);
  }
});
