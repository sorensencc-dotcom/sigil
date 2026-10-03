// sigil/bridges/v1/session-store.mjs
// One CLI session per (room, endpoint): a bridge serves one endpoint, so the
// file is keyed by room. Value: { session_id, last_seq_by_thread }, where
// last_seq_by_thread[thread_root_id] is the room_seq the last turn in that
// thread read up to, so a resumed session only gets that thread's unseen
// messages. Entries from before phase 2 fixes carry a room-wide last_seq,
// which is ignored (worst case: one turn re-shows up to 20 messages).
import fs from 'node:fs';
import path from 'node:path';

export function createSessionStore(filePath) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
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
