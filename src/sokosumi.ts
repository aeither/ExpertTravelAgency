import type { Config } from './config.js';
import type { Storage } from './store.js';
import type { Travel } from './travel.js';
import { ApiError } from './errors.js';
import { TaskInputError } from './coworker-search.js';
import { answerTask, answerFollowUp, needsPayment } from './planner.js';
import { PaidFlow, proofBlock, collectionComment } from './sokosumi-paid.js';

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
  private async mps(path: string, body: unknown) {
    const managed = new URL(this.config.MASUMI_URL).hostname === 'app.masumi.network';
    const response = await this.request(this.config.MASUMI_URL + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...(managed ? { Authorization: `Bearer ${this.config.MASUMI_TOKEN}` } : { token: this.config.MASUMI_TOKEN }) }, body: JSON.stringify(body),
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== 'success') throw new ApiError(502, 'MASUMI_REQUEST_FAILED', `Payment node returned HTTP ${response.status} for ${path}. Inspect the saved payment before retrying.`);
    return payload.data;
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
        if (!['READY', 'RUNNING', 'COMPLETED', 'INPUT_REQUIRED'].includes(task.status)) continue;
        if (task.runAt && new Date(task.runAt).getTime() > Date.now()) continue;
        const outcome = await this.advance(task);
        if (outcome !== 'skipped' && outcome !== 'waiting') return { status: outcome, execution_only: !this.config.SOKOSUMI_PAID };
      }
      cursor = page.meta?.pagination?.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ApiError(502, 'SOKOSUMI_PAGINATION_ERROR', 'Repeated task cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { status: 'idle', execution_only: !this.config.SOKOSUMI_PAID };
  }
  // The traveller's answer to our last question: the newest user comment after it, or a new description set back to Ready.
  private async reply(task: any, state: any): Promise<{ text: string; fromEdit?: boolean } | undefined> {
    if (task.status === 'READY' && task.description !== state.input) return { text: task.description, fromEdit: true };
    const events = (await this.api(`/v1/tasks/${task.id}/events?limit=100`)).data as any[];
    const asked = events.filter(e => e.status === 'INPUT_REQUIRED' && e.actor?.id === task.assigneeId).map(e => String(e.createdAt ?? '')).sort().at(-1) ?? '';
    const answers = events.filter(e => typeof e.comment === 'string' && e.comment.trim() && e.actor?.type === 'user' && String(e.createdAt ?? '') > asked && !state.used?.includes(e.id)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const answer = answers.at(-1);
    if (!answer) return undefined;
    state.used = [...(state.used ?? []), answer.id];
    return { text: answer.comment.trim() };
  }
  private async advance(task: any) {
    const lockId = `sokosumi:${task.id}`;
    if (this.active.has(lockId)) return 'busy';
    this.active.add(lockId);
    let outcome = 'busy';
    try {
      await this.store.withJobLock(lockId, async () => {
        // The journal is keyed by task, not by its text, so a traveller can edit the description and carry on. Older journals are found by key.
        const found = await this.store.find(lockId);
        const claim = found ? { operation: found, fresh: false } : await this.store.claim('sokosumi-task', lockId, { assigneeId: task.assigneeId, organizationId: task.organizationId });
        const op = claim.operation!;
        let state = op.response ?? { phase: 'new', input: task.description };
        const save = async () => this.store.finish(op.id, state.phase, state);
        // A task we have never worked on that is already waiting for input belongs to someone else.
        if (claim.fresh && task.status === 'INPUT_REQUIRED') { state = { phase: 'blocked', reason: 'NOT_OURS', input: task.description }; await save(); outcome = 'skipped'; return; }
        // The traveller answered our question (a reply on the task, or an edited description set back to Ready): continue the same task.
        if (state.phase === 'blocked' && state.reason === 'INPUT_REQUIRED' && ['READY', 'INPUT_REQUIRED'].includes(task.status)) {
          const reply = await this.reply(task, state);
          if (reply !== undefined) { state = { phase: 'new', input: task.description, resumed: true, ...(state.used ? { used: state.used } : {}), ...(reply.fromEdit ? {} : { reply: reply.text, ...(state.context ? { context: state.context } : {}) }) }; await save(); }
        }
        // Only a task that books a hotel is charged (decided below, before any work). Older saved states without the flag stay paid.
        let paid = this.config.SOKOSUMI_PAID && state.charged !== false ? new PaidFlow({ config: this.config, mps: (p, b) => this.mps(p, b), event: (id, b) => this.api(`/v1/tasks/${id}/events`, b), save }) : undefined;
        // Completed paid tasks stay under watch until the node reports collection.
        if (state.phase === 'collecting') {
          if (await paid!.collection(state) === 'settled') {
            // Tell the user where to verify the payout. Mark pending first so a crash never posts it twice.
            if (!state.paid.proofPosted) { state.paid.proofPosted = 'pending'; await save(); await this.api(`/v1/tasks/${task.id}/events`, { comment: collectionComment(state.paid, this.config) }); state.paid.proofPosted = 'done'; }
            state.phase = 'completed'; await save(); outcome = 'settled';
          } else outcome = 'waiting';
          return;
        }
        if (state.phase === 'completed' || state.phase === 'blocked') { outcome = 'skipped'; return; }
        if (task.status === 'COMPLETED') {
          if (state.phase !== 'complete-pending') { outcome = 'skipped'; return; }
          const events = (await this.api(`/v1/tasks/${task.id}/events?limit=100`)).data;
          if (events.some((e: any) => e.status === 'COMPLETED' && e.comment === (state.final ?? state.answer) && e.actor?.id === task.assigneeId)) { state.phase = paid ? 'collecting' : 'completed'; await save(); outcome = 'completed'; return; }
          throw new ApiError(409, 'SOKOSUMI_UNCERTAIN', 'Completion does not match the saved answer. Operator inspection is required.');
        }
        if (state.phase === 'new' && task.status !== 'READY' && !(state.resumed && task.status === 'INPUT_REQUIRED')) { outcome = 'skipped'; return; }
        // Read the authoritative task immediately before changing it.
        const current = (await this.api(`/v1/tasks/${task.id}`)).data;
        if (current.assigneeId !== task.assigneeId || current.description !== state.input || !(['READY', 'RUNNING'].includes(current.status) || (state.resumed && current.status === 'INPUT_REQUIRED'))) throw new ApiError(409, 'SOKOSUMI_TASK_CHANGED', 'Task changed before execution.');
        if (current.organizationId === null) {
          const personal = (await this.api(`/v1/workspaces/${current.workspace.id}`, undefined, current.ownerId)).data;
          if (personal.organizationId !== null) throw new ApiError(403, 'SOKOSUMI_WORKSPACE_ERROR', 'Personal Workspace authorization failed.');
        }
        if (state.phase === 'new') {
          if (current.status !== 'READY' && !(state.resumed && current.status === 'INPUT_REQUIRED')) { outcome = 'skipped'; return; }
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
        const owner = String(current.ownerId ?? current.organizationId ?? 'anonymous');
        if (state.phase === 'searching' && paid && state.charged === undefined && !state.paid) {
          state.charged = await needsPayment({ travel: this.travel, store: this.store, config: this.config }, owner, [state.input, state.context].filter(Boolean).join(' '), state.reply);
          await save();
          if (!state.charged) paid = undefined;
        }
        if (state.phase === 'searching' && paid) {
          if (await paid.beforeWork(task, state) === 'waiting') { outcome = 'waiting'; return; }
        }
        if (state.phase === 'searching') {
          try {
            const deps = { travel: this.travel, store: this.store, config: this.config }, url = 'https://origin-travel-agent.vercel.app';
            const earlier = [state.input, state.context].filter(Boolean).join(' ');
            const output = state.reply !== undefined ? await answerFollowUp(earlier, state.reply, deps, owner, url) : await answerTask(earlier, deps, owner, url);
            state = { ...state, phase: 'result-saved', answer: output.answer, summary: output.summary }; await save();
          } catch (error) {
            const status = error instanceof TaskInputError ? 'INPUT_REQUIRED' : 'FAILED';
            const comment = error instanceof TaskInputError ? error.message : 'Sorry, I could not finish this. Please try again in a minute. If a booking was in progress, ask the team to check it first.';
            // Keep what the traveller already told us, so the next answer only has to add what is still missing.
            if (state.reply !== undefined && status === 'INPUT_REQUIRED') state.context = [state.context, state.reply].filter(Boolean).join(' ');
            delete state.reply; state.phase = 'blocked'; state.reason = status; await save();
            await this.api(`/v1/tasks/${task.id}/events`, { status, comment });
            outcome = status.toLowerCase(); return;
          }
        }
        if (state.phase === 'complete-pending') { outcome = 'inspection_required'; return; }
        if (paid && await paid.afterWork(task, state) === 'waiting') { outcome = 'waiting'; return; }
        if (paid && !state.final) { state.final = state.answer + proofBlock(state.paid, this.config); await save(); }
        const latest = (await this.api(`/v1/tasks/${task.id}`)).data;
        if (latest.status !== 'RUNNING' || latest.description !== state.input || latest.assigneeId !== task.assigneeId) throw new ApiError(409, 'SOKOSUMI_TASK_CHANGED', 'Task changed before completion.');
        state.phase = 'complete-pending'; await save();
        const event = (await this.api(`/v1/tasks/${task.id}/events`, { status: 'COMPLETED', comment: state.final ?? state.answer })).data;
        if (event.status !== 'COMPLETED' || !event.id || event.taskId !== task.id) throw new ApiError(502, 'SOKOSUMI_COMPLETE_UNCERTAIN', 'Completion event was not confirmed.');
        state.phase = paid ? 'collecting' : 'completed'; state.eventId = event.id; await save(); outcome = 'completed';
      });
    } finally { this.active.delete(lockId); }
    return outcome;
  }
}
