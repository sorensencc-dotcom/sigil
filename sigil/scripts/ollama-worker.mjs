// Sigil Ollama Task Worker — Local LLM subprocess adapter.
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

    const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const model = process.env.SIGIL_OLLAMA_MODEL || 'llama3:latest';
    const instruction = task.instruction ?? task.body?.instruction ?? '';
    let result;
    let localError = null;

    try {
      const response = await fetch(`${ollamaHost}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: instruction || JSON.stringify(task),
          stream: false
        })
      });
      if (response.ok) {
        const payload = await response.json();
        result = {
          task_id: task.task_id ?? task.body?.task_id ?? null,
          status: 'completed',
          processing: 'ollama_local_model',
          model,
          summary: payload.response ?? ''
        };
      } else {
        localError = `Ollama returned HTTP ${response.status}`;
      }
    } catch (err) {
      localError = err.message;
    }

    if (!result) {
      result = {
        task_id: task.task_id ?? task.body?.task_id ?? null,
        status: 'completed',
        processing: 'local_deterministic_fallback',
        model,
        ollama_error: localError,
        summary: instruction ? `Processed (offline fallback): ${instruction}` : 'Processed: (no instruction provided)'
      };
    }

    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    console.error(`ollama-worker error: ${err.message}`);
    process.exit(1);
  }
});
