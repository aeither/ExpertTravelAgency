import dotenv from 'dotenv';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { hostname } from 'node:os';
import { runTravelTask, TaskInputError } from '../src/coworker-search.js';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const coworkerId = process.env.SOKOSUMI_COWORKER_ID;
const key = process.env.SOKOSUMI_COWORKER_API_KEY;
const api = 'https://api.preprod.sokosumi.com';
const travelUrl = process.env.ORIGIN_TRAVEL_URL ?? 'https://origin-travel-agent.vercel.app';
const directory = resolve(process.env.SOKOSUMI_WORKER_DATA_PATH ?? '.data/sokosumi-worker');
if (!coworkerId || !/^[a-f0-9-]{36}$/.test(coworkerId) || !key?.startsWith('coworker_')) throw new Error('Configure SOKOSUMI_COWORKER_ID and a dedicated SOKOSUMI_COWORKER_API_KEY.');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, 'worker.lock');
if (existsSync(lock)) {
  const owner = JSON.parse(readFileSync(lock, 'utf8'));
  if (owner.host !== hostname()) throw new Error('Worker storage belongs to another host; stop its executor and inspect the lock before moving storage.');
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
  if (alive) throw new Error('A worker is already running.');
  unlinkSync(lock);
}
const fd = openSync(lock, 'wx', 0o600);
writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname() })); closeSync(fd);
process.once('exit', () => { try { unlinkSync(lock); } catch {} });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; });

async function http(path: string, body?: unknown) {
  const response = await fetch(api + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Sokosumi HTTP ${response.status}`);
  return await response.json() as any;
}
function cli(command: string[], task: any) {
  const env = { ...process.env }; delete env.SOKOSUMI_API_KEY; delete env.SOKOSUMI_AUTH_TOKEN;
  const context = task.organizationId ? ['--organization-id', task.organizationId] : ['--personal'];
  const result = spawnSync('sokosumi', ['--preprod', 'runtime', ...command, '--coworker-id', coworkerId!, ...context, '--api-key-stdin', '--json'], { env, input: key, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) {
    const grant = /grant_required|grant_denied|grant_revoked/.exec(result.stdout + result.stderr)?.[0];
    throw new Error(grant ?? 'Runtime write not confirmed; inspect the task before retrying.');
  }
  return JSON.parse(result.stdout);
}
function save(id: string, state: any) {
  const path = join(directory, `${id}.json`);
  writeFileSync(path + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(path + '.tmp', path);
}
async function work(task: any) {
  if (task.assigneeId !== coworkerId) return;
  const id = task.id;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task ID');
  const path = join(directory, `${id}.json`);
  let state: any = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (state.phase === 'completed' || state.phase === 'blocked') return;
  if (task.status === 'COMPLETED' && state.phase === 'complete-pending') {
    const events = await http(`/v1/tasks/${id}/events?limit=100`);
    if (events.data.some((e: any) => e.status === 'COMPLETED' && e.comment === state.answer && e.actor?.id === coworkerId)) { save(id, { ...state, phase: 'completed' }); return; }
    throw new Error('Completion differs from saved result; inspect the task.');
  }
  if (!['READY', 'RUNNING'].includes(task.status)) return;
  if (!state.phase && task.status !== 'READY') return; // Never take over another executor's task.
  if (!state.phase) { state = { phase: 'start-pending', input: task.description, organizationId: task.organizationId }; save(id, state); }
  if (state.phase === 'start-pending') {
    if (task.status === 'READY') {
      try { const started = cli(['start', id], task); if (started.status !== 'RUNNING') throw new Error('Start not confirmed'); }
      catch (error) { save(id, { ...state, phase: 'blocked', reason: (error as Error).message }); throw error; }
    } else {
      const events = await http(`/v1/tasks/${id}/events?limit=100`);
      if (!events.data.some((e: any) => e.status === 'RUNNING' && e.actor?.id === coworkerId)) throw new Error('Start event not confirmed');
    }
    state.phase = 'searching'; save(id, state);
  }
  if (state.phase === 'searching') {
    try {
      const output = await runTravelTask(state.input ?? '', travelUrl);
      state = { ...state, phase: 'result-saved', answer: output.answer, response: output.result };
      save(id, state);
    } catch (error) {
      const status = error instanceof TaskInputError ? 'INPUT_REQUIRED' : 'FAILED';
      const comment = error instanceof TaskInputError ? error.message : 'Travel supplier search failed. No booking or payment was made. Ask the operator to inspect the search service before retrying.';
      save(id, { ...state, phase: 'blocked', reason: status });
      await http(`/v1/tasks/${id}/events`, { status, comment });
      return;
    }
  }
  if (state.phase === 'result-saved') {
    const latest = (await http(`/v1/tasks/${id}`)).data;
    if (latest.status !== 'RUNNING' || latest.assigneeId !== coworkerId) throw new Error('Task no longer running or assigned; no completion submitted.');
    if (latest.description !== state.input) throw new Error('Task input changed; inspect before completing.');
    const resultFile = join(directory, `${id}.txt`);
    writeFileSync(resultFile, state.answer, { mode: 0o600 });
    state.phase = 'complete-pending'; save(id, state);
    const completion = cli(['complete', id, '--result-file', resultFile], task);
    if (completion.status !== 'COMPLETED' || !completion.eventId) throw new Error('Completion not confirmed');
    save(id, { ...state, phase: 'completed', completion });
    console.log(`Completed ${id}`);
  }
  // Uncertain completion is read back next poll; it is never blindly resubmitted.
}

try {
  const me = (await http('/v1/coworkers/me')).data;
  if (me.id !== coworkerId || me.archivedAt !== null || !me.capabilities.includes('tasks')) throw new Error('Runtime identity or task capability mismatch');
  console.log(`Origin task worker started for ${coworkerId}; execution rehearsal only, no payment submission.`);
  do {
    try {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const params = new URLSearchParams({ coworkerId, limit: '100', ...(cursor ? { cursor } : {}) });
        const page = await http(`/v1/tasks?${params}`);
        for (const task of page.data) {
          if (stopping) break;
          try { await work(task); } catch (error) { console.error(`Task ${task.id}: ${(error as Error).message}`); }
        }
        cursor = page.meta?.pagination?.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeated pagination cursor');
        if (cursor) seen.add(cursor);
      } while (cursor && !stopping);
    } catch (error) { console.error((error as Error).message); }
    if (process.argv.includes('--once') || stopping) break;
    await new Promise(r => setTimeout(r, 5000));
  } while (!stopping);
} finally { process.exitCode = 0; }
