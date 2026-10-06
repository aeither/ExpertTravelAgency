import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export interface Operation { id: string; key: string; hash: string; kind: string; state: string; response: any; created_at: string }
export interface Storage {
  claim(kind: string, key: string, input: unknown): { operation: Operation; fresh: boolean } | Promise<{ operation: Operation; fresh: boolean }>;
  finish(id: string, state: string, response: unknown): void | Promise<void>;
  get(id: string): Operation | Promise<Operation>;
  saveJob(job: any): void | Promise<void>;
  job(id: string): any;
  jobByNonce(nonce: string): any;
  pendingJobs(): any[] | Promise<any[]>;
  withJobLock(id: string, work: () => Promise<void>): Promise<void>;
  close(): void | Promise<void>;
}
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, key TEXT UNIQUE, hash TEXT, kind TEXT, state TEXT, response TEXT, created_at TEXT); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, nonce TEXT UNIQUE, input_hash TEXT, data TEXT);');
  }
  claim(kind: string, key: string, input: unknown): { operation: Operation; fresh: boolean } {
    const hash = sha256(canonical(input));
    const existing = this.db.prepare('SELECT * FROM operations WHERE key = ?').get(key) as any;
    if (existing) {
      if (existing.hash !== hash || existing.kind !== kind) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different request.');
      return { operation: this.decode(existing), fresh: false };
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, key, hash, kind, 'started', 'null', new Date().toISOString());
    return { operation: this.get(id), fresh: true };
  }
  finish(id: string, state: string, response: unknown) { this.db.prepare('UPDATE operations SET state = ?, response = ? WHERE id = ?').run(state, JSON.stringify(response), id); }
  get(id: string): Operation {
    const row = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any;
    if (!row) throw new ApiError(404, 'OPERATION_NOT_FOUND', 'Operation not found.');
    return this.decode(row);
  }
  private decode(row: any): Operation { return { ...row, response: JSON.parse(row.response) }; }
  saveJob(job: any) { this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(job.id, job.nonce, job.inputHash, JSON.stringify(job)); }
  job(id: string): any { const row = this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(id) as any; return row ? JSON.parse(row.data) : undefined; }
  jobByNonce(nonce: string): any { const row = this.db.prepare('SELECT data FROM jobs WHERE nonce = ?').get(nonce) as any; return row ? JSON.parse(row.data) : undefined; }
  pendingJobs(): any[] { return (this.db.prepare('SELECT data FROM jobs').all() as any[]).map(row => JSON.parse(row.data)).filter(j => !['completed', 'failed'].includes(j.status)); }
  close() { this.db.close(); }
  async withJobLock(_id: string, work: () => Promise<void>) { await work(); }
}
