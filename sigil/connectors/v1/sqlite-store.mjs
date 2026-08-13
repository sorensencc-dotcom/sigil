import { DatabaseSync } from 'node:sqlite';

export class SqliteStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbox (message_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, state TEXT NOT NULL, received_at TEXT NOT NULL, failure_reason TEXT); CREATE TABLE IF NOT EXISTS outbox (message_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  putInbox(envelope) { const stmt = this.db.prepare('INSERT OR IGNORE INTO inbox VALUES (?, ?, ?, ?, ?)'); const now = new Date().toISOString(); const result = stmt.run(envelope.message_id, JSON.stringify(envelope), 'stored', now, null); return { duplicate: result.changes === 0, message_id: envelope.message_id }; }
  putOutbox(envelope) { this.db.prepare('INSERT OR IGNORE INTO outbox VALUES (?, ?, ?, ?)').run(envelope.message_id, JSON.stringify(envelope), 'pending', new Date().toISOString()); return envelope.message_id; }
  getInbox(messageId) { const row = this.db.prepare('SELECT * FROM inbox WHERE message_id = ?').get(messageId); return row ? { ...row, envelope: JSON.parse(row.envelope) } : null; }
  close() { this.db.close(); }
}
