import { spawn } from 'node:child_process';

const command = process.env.SIGIL_CLAUDE_CLI_COMMAND ?? 'claude';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let task;
  try { task = JSON.parse(input); } catch (error) { process.stderr.write(`Invalid task JSON: ${error.message}\n`); process.exit(1); }
  const instruction = task.instruction ?? task.body?.instruction ?? JSON.stringify(task);
  const child = spawn(command, ['-p', instruction, '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { process.stderr.write(`Claude CLI failed to start: ${error.message}\n`); process.exit(1); });
  child.on('close', (code) => {
    if (code !== 0) { process.stderr.write(stderr || `Claude CLI exited with ${code}\n`); process.exit(1); return; }
    try {
      const payload = JSON.parse(stdout);
      process.stdout.write(JSON.stringify({ task_id: task.task_id ?? task.body?.task_id ?? null, status: 'completed', processing: 'claude_cli_subscription_or_login', summary: payload.result ?? payload.content?.[0]?.text ?? payload }));
    } catch (error) { process.stderr.write(`Claude CLI returned invalid JSON: ${error.message}\n`); process.exit(1); }
  });
});
