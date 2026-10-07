import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { canonical, sha256, type Storage, type Operation } from './store.js';

export class PostgresStore implements Storage {
  private pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
    // A dropped idle connection emits 'error' on the pool; without a listener that crashes the process. The pool replaces the client by itself.
    this.pool.on('error', error => console.error('postgres idle client error:', String((error as Error)?.message ?? error).slice(0, 200)));
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, response JSONB, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL, input_hash TEXT NOT NULL, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS supplier_credentials (name TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_pending_idx ON jobs (id) WHERE data->>'status' NOT IN ('completed','failed');`);
  }
  async claim(kind: string, key: string, input: unknown) {
    const hash = sha256(canonical(input));
    const inserted = await this.pool.query<Operation>('INSERT INTO operations VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(key) DO NOTHING RETURNING *', [randomUUID(), key, hash, kind, 'started', null, new Date().toISOString()]);
    if (inserted.rowCount) return { operation: inserted.rows[0], fresh: true };
    const { rows } = await this.pool.query<Operation>('SELECT * FROM operations WHERE key=$1', [key]);
    const operation = rows[0];
    if (!operation || operation.hash !== hash || operation.kind !== kind) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different request.');
    return { operation, fresh: false };
  }
  async finish(id: string, state: string, response: unknown) { await this.pool.query('UPDATE operations SET state=$1,response=$2 WHERE id=$3', [state, JSON.stringify(response), id]); }
  async get(id: string) {
    const { rows } = await this.pool.query<Operation>('SELECT * FROM operations WHERE id=$1', [id]);
    if (!rows[0]) throw new ApiError(404, 'OPERATION_NOT_FOUND', 'Operation not found.');
    return rows[0];
  }
  async find(key: string) { return (await this.pool.query<Operation>('SELECT * FROM operations WHERE key=$1', [key])).rows[0]; }
  async saveJob(job: any) { await this.pool.query('INSERT INTO jobs VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [job.id, job.nonce, job.inputHash, JSON.stringify(job)]); }
  async job(id: string) { return (await this.pool.query('SELECT data FROM jobs WHERE id=$1', [id])).rows[0]?.data; }
  async jobByNonce(nonce: string) { return (await this.pool.query('SELECT data FROM jobs WHERE nonce=$1', [nonce])).rows[0]?.data; }
  async pendingJobs() { return (await this.pool.query("SELECT data FROM jobs WHERE data->>'status' NOT IN ('completed','failed') ORDER BY id LIMIT 20")).rows.map(r => r.data); }
  async withJobLock(id: string, work: () => Promise<void>) {
    // Session advisory locks require a direct (non-PgBouncer) connection.
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [id])).rows[0].locked;
      if (locked) await work();
    } finally {
      try {
        if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [id]);
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    }
  }
  async credential(name: string) { return (await this.pool.query('SELECT data FROM supplier_credentials WHERE name=$1', [name])).rows[0]?.data; }
  async saveCredential(name: string, data: unknown) { await this.pool.query('INSERT INTO supplier_credentials VALUES ($1,$2) ON CONFLICT(name) DO UPDATE SET data=excluded.data', [name, JSON.stringify(data)]); }
  async close() { await this.pool.end(); }
}
