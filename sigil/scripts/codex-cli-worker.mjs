import { spawn } from 'node:child_process';

const command = process.env.SIGIL_CODEX_CLI_COMMAND ?? 'codex';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let task;
  try { task = JSON.parse(input); } catch (error) { process.stderr.write(`Invalid task JSON: ${error.message}\n`); process.exit(1); }
  const instruction = task.instruction ?? task.body?.instruction ?? JSON.stringify(task);
  const child = spawn(command, ['exec', '--ephemeral', '--skip-git-repo-check', instruction], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { process.stderr.write(`Codex CLI failed to start: ${error.message}\n`); process.exit(1); });
  child.on('close', (code) => {
    if (code !== 0) { process.stderr.write(stderr || `Codex CLI exited with ${code}\n`); process.exit(1); return; }
    process.stdout.write(JSON.stringify({ task_id: task.task_id ?? task.body?.task_id ?? null, status: 'completed', processing: 'codex_cli_subscription_or_login', summary: stdout.trim() }));
  });
});
