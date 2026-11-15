import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';

export interface UploadRecord { job_id: string; owner: string; filename: string; state: string; task_id: string | null; }
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class State {
  readonly db: DatabaseSync;
  constructor(readonly config: Config) {
    mkdirSync(dirname(config.statePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.statePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (
        job_id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        filename TEXT NOT NULL, task_id TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'uploaded',
        created INTEGER NOT NULL, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner);
      CREATE INDEX IF NOT EXISTS uploads_state ON uploads(state);
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);`);
    const version = this.db.prepare('SELECT version FROM schema_version').get() as { version: number };
    if (version.version !== 1) throw new Error('Unsupported gateway state schema');
    // A compression request interrupted after dispatch may have reached upstream.
    // Never permit a second dispatch without the task ID: keep fail-closed ownership.
    this.db.prepare("UPDATE uploads SET state='uncertain' WHERE state='dispatching'").run();
    this.cleanup();
  }
  cleanup() {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    this.db.prepare('DELETE FROM uploads WHERE expires < ?').run(now);
  }
  newSession(): { token: string; id: string } {
    const token = randomBytes(32).toString('base64url');
    const id = hash(token);
    this.db.prepare('INSERT INTO sessions(id, expires) VALUES (?, ?)').run(id, Date.now() + this.config.sessionSeconds * 1000);
    return { token, id };
  }
  findSession(token: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const id = hash(token);
    return this.db.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(id, Date.now()) ? id : undefined;
  }
  upload(job: string, owner: string, filename: string) {
    this.db.prepare('INSERT INTO uploads(job_id,owner,filename,created,expires) VALUES(?,?,?,?,?)')
      .run(job, owner, filename, Date.now(), Date.now() + this.config.recordSeconds * 1000);
  }
  getUpload(job: string, owner: string): UploadRecord | undefined {
    return this.db.prepare('SELECT * FROM uploads WHERE job_id=? AND owner=? AND expires>?').get(job, owner, Date.now()) as UploadRecord | undefined;
  }
  getTask(task: string, owner: string): UploadRecord | undefined {
    return this.db.prepare('SELECT * FROM uploads WHERE task_id=? AND owner=? AND expires>?').get(task, owner, Date.now()) as UploadRecord | undefined;
  }
  count(owner?: string, active = false): number {
    const where = ['expires>?'];
    const params: (string | number)[] = [Date.now()];
    if (owner) { where.push('owner=?'); params.push(owner); }
    if (active) where.push("state IN ('dispatching','active','uncertain')");
    return (this.db.prepare(`SELECT count(*) AS count FROM uploads WHERE ${where.join(' AND ')}`).get(...params) as { count: number }).count;
  }
  claim(job: string, owner: string): boolean {
    return this.db.prepare("UPDATE uploads SET state='dispatching' WHERE job_id=? AND owner=? AND state='uploaded'").run(job, owner).changes === 1;
  }
  dispatched(job: string, task: string) {
    this.db.prepare("UPDATE uploads SET state='active',task_id=? WHERE job_id=? AND state='dispatching'").run(task, job);
  }
  release(job: string) { this.db.prepare("UPDATE uploads SET state='uploaded' WHERE job_id=? AND state='dispatching'").run(job); }
  uncertain(job: string) { this.db.prepare("UPDATE uploads SET state='uncertain' WHERE job_id=? AND state='dispatching'").run(job); }
  finish(task: string) { this.db.prepare("UPDATE uploads SET state='terminal' WHERE task_id=?").run(task); }
  activeTasks(): string[] { return (this.db.prepare("SELECT task_id FROM uploads WHERE state='active' AND task_id IS NOT NULL").all() as { task_id: string }[]).map(r => r.task_id); }
  close() { this.db.close(); }
}
