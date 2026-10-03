// sigil/bridges/v1/session-store.mjs
// One CLI session per (room, endpoint): a bridge serves one endpoint, so the
// file is keyed by room. last_seq is the highest room_seq already shown to
// the CLI, so a resumed session only gets messages it has not seen.
import fs from 'node:fs';
import path from 'node:path';

export function createSessionStore(filePath) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  return {
    get(roomId) { return read()[roomId] ?? null; },
    set(roomId, value) {
      const all = read();
      all[roomId] = value;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(all, null, 2));
      fs.renameSync(temp, filePath);
    },
  };
}
