import type { Config } from './config.js';
import type { Storage } from './store.js';
import type { Travel } from './travel.js';
import { ApiError } from './errors.js';
import { runTravelTask, TaskInputError } from './coworker-search.js';

// One bounded invocation per request; persistent journal + Postgres session lock.
export class Sokosumi {
  private active = new Set<string>();
  constructor(private config: Config, private store: Storage, private travel: Travel, private request: typeof fetch = fetch) {}
  get configured() { return !!this.config.SOKOSUMI_COWORKER_ID && this.config.SOKOSUMI_COWORKER_API_KEY.startsWith('coworker_'); }
  private async api(path: string, body?: unknown, ownerId?: string) {
    const response = await this.request('https://api.preprod.sokosumi.com' + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${this.config.SOKOSUMI_COWORKER_API_KEY}`, 'Content-Type': 'application/json', ...(ownerId ? { 'X-Context-User-Id': ownerId } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload: any = await response.json();
    if (!response.ok) {
      const kind = ['grant_required', 'grant_denied', 'grant_revoked'].includes(payload.kind) ? payload.kind : 'request_failed';
      throw new ApiError(502, 'SOKOSUMI_ACCESS_ERROR', `Sokosumi returned HTTP ${response.status}: ${kind}. Inspect the same task before retrying.`);
    }
    return payload;
  }
  async tick() {
    if (!this.configured) throw new ApiError(503, 'SOKOSUMI_UNCONFIGURED', 'Coworker runtime is not configured.');
    const me = (await this.api('/v1/coworkers/me')).data;
    if (me.id !== this.config.SOKOSUMI_COWORKER_ID || me.archivedAt !== null || !me.capabilities?.includes('tasks')) throw new ApiError(503, 'SOKOSUMI_IDENTITY_ERROR', 'Coworker runtime identity is unavailable.');
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const params = new URLSearchParams({ coworkerId: me.id, limit: '100', ...(cursor ? { cursor } : {}) });
      const page = await this.api(`/v1/tasks?${params}`);
      for (const task of page.data) {
        if (task.assigneeId !== me.id || !/^[a-f0-9-]{36}$/.test(task.id)) continue;
        if (!['READY', 'RUNNING', 'COMPLETED'].includes(task.status)) continue;
        if (task.runAt && new Date(task.runAt).getTime() > Date.now()) continue;
        const outcome = await this.advance(task);
        if (outcome !== 'skipped') return { status: outcome, execution_only: true };
      }
      cursor = page.meta?.pagination?.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ApiError(502, 'SOKOSUMI_PAGINATION_ERROR', 'Repeated task cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { status: 'idle', execution_only: true };
  }
  private async advance(task: any) {
    const lockId = `sokosumi:${task.id}`;
    if (this.active.has(lockId)) return 'busy';
    this.active.add(lockId);
    let outcome = 'busy';
    try {
      await this.store.withJobLock(lockId, async () => {
        const claim = await this.store.claim('sokosumi-task', lockId, { description: task.description, assigneeId: task.assigneeId, organizationId: task.organizationId });
        const op = claim.operation!;
        let state = op.response ?? { phase: 'new', input: task.description };
        const save = async () => this.store.finish(op.id, state.phase, state);
        if (state.phase === 'completed' || state.phase === 'blocked') { outcome = 'skipped'; return; }
        if (task.status === 'COMPLETED') {
          if (state.phase !== 'complete-pending') { outcome = 'skipped'; return; }
          const events = (await this.api(`/v1/tasks/${task.id}/events?limit=100`)).data;
          if (events.some((e: any) => e.status === 'COMPLETED' && e.comment === state.answer && e.actor?.id === task.assigneeId)) { state.phase = 'completed'; await save(); outcome = 'completed'; return; }
          throw new ApiError(409, 'SOKOSUMI_UNCERTAIN', 'Completion does not match the saved answer. Operator inspection is required.');
        }
        if (state.phase === 'new' && task.status !== 'READY') { outcome = 'skipped'; return; }
        // Read the authoritative task immediately before changing it.
        const current = (await this.api(`/v1/tasks/${task.id}`)).data;
        if (current.assigneeId !== task.assigneeId || current.description !== state.input || !['READY', 'RUNNING'].includes(current.status)) throw new ApiError(409, 'SOKOSUMI_TASK_CHANGED', 'Task changed before execution.');
        if (current.organizationId === null) {
          const personal = (await this.api(`/v1/workspaces/${current.workspace.id}`, undefined, current.ownerId)).data;
          if (personal.organizationId !== null) throw new ApiError(403, 'SOKOSUMI_WORKSPACE_ERROR', 'Personal Workspace authorization failed.');
        }
        if (state.phase === 'new') {
          if (current.status !== 'READY') { outcome = 'skipped'; return; }
          state.phase = 'start-pending'; await save();
          // Core enforces Vendor Workspace access on the event write.
          const started = (await this.api(`/v1/tasks/${task.id}/events`, { status: 'RUNNING' })).data;
          if (started.status !== 'RUNNING' || !started.id) throw new ApiError(502, 'SOKOSUMI_START_UNCERTAIN', 'Start event was not confirmed.');
          state.phase = 'searching'; await save();
        } else if (state.phase === 'start-pending') {
          const events = (await this.api(`/v1/tasks/${task.id}/events?limit=100`)).data;
          if (current.status !== 'RUNNING' || !events.some((e: any) => e.status === 'RUNNING' && e.actor?.id === task.assigneeId)) throw new ApiError(409, 'SOKOSUMI_START_UNCERTAIN', 'Inspect the pending start before retrying.');
          state.phase = 'searching'; await save();
        }
        if (state.phase === 'searching') {
          try {
            const output = await runTravelTask(state.input ?? '', 'https://origin-travel-agent.vercel.app', (async (_url, options) => Response.json(await this.travel.trip(JSON.parse(String(options?.body))))) as typeof fetch);
            state = { ...state, phase: 'result-saved', answer: output.answer, summary: output.result.summary }; await save();
          } catch (error) {
            const status = error instanceof TaskInputError ? 'INPUT_REQUIRED' : 'FAILED';
            const comment = error instanceof TaskInputError ? error.message : 'Supplier search failed. No booking or payment was made. Ask the operator to inspect before retrying.';
            state.phase = 'blocked'; state.reason = status; await save();
            await this.api(`/v1/tasks/${task.id}/events`, { status, comment });
            outcome = status.toLowerCase(); return;
          }
        }
        if (state.phase === 'complete-pending') { outcome = 'inspection_required'; return; }
        const latest = (await this.api(`/v1/tasks/${task.id}`)).data;
        if (latest.status !== 'RUNNING' || latest.description !== state.input || latest.assigneeId !== task.assigneeId) throw new ApiError(409, 'SOKOSUMI_TASK_CHANGED', 'Task changed before completion.');
        state.phase = 'complete-pending'; await save();
        const event = (await this.api(`/v1/tasks/${task.id}/events`, { status: 'COMPLETED', comment: state.answer })).data;
        if (event.status !== 'COMPLETED' || !event.id || event.taskId !== task.id) throw new ApiError(502, 'SOKOSUMI_COMPLETE_UNCERTAIN', 'Completion event was not confirmed.');
        state.phase = 'completed'; state.eventId = event.id; await save(); outcome = 'completed';
      });
    } finally { this.active.delete(lockId); }
    return outcome;
  }
}
