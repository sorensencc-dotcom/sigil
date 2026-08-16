import fs from 'node:fs/promises';
import path from 'node:path';

export async function appendInboxLedger(ledgerPath, record) {
  if (!ledgerPath) return;
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, JSON.stringify(record) + '\n', 'utf8');
}

export async function readInboxLedger(ledgerPath, { limit = 50 } = {}) {
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
    return records.slice(-limit);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
