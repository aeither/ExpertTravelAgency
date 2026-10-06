import type { Config } from './config.js';
import type { Storage } from './store.js';
import { ApiError } from './errors.js';

// Journal first, supplier second: a repeat of the same key replays the saved result instead of booking twice.
export async function journaledBooking(store: Storage, config: Config, kind: string, key: string, input: unknown, action: (id: string, submitted: () => Promise<void>) => Promise<unknown>) {
  const claimed = await store.claim(kind, key, { mode: config.TRAVEL_MODE, duffel_mode: config.DUFFEL_ACCESS_TOKEN.startsWith('duffel_live_') ? 'production' : 'sandbox', input });
  const op = claimed.operation;
  if (!claimed.fresh) {
    if (op.state === 'succeeded') return { operation_id: op.id, replayed: true, ...op.response };
    throw new ApiError(409, 'OPERATION_REQUIRES_INSPECTION', 'This operation already exists. Inspect it before creating another booking.', { operation_id: op.id, state: op.state });
  }
  let submitted = false;
  try {
    const result = await action(op.id, async () => { submitted = true; await store.finish(op.id, 'submitted', null); });
    await store.finish(op.id, 'succeeded', result);
    return { operation_id: op.id, replayed: false, ...result as object };
  } catch (error: any) {
    const state = submitted && (error.uncertain || !(error instanceof ApiError)) ? 'uncertain' : 'failed';
    await store.finish(op.id, state, { error: { code: error.code ?? 'INTERNAL_ERROR' } });
    throw new ApiError(error.statusCode ?? 500, error.code ?? 'INTERNAL_ERROR', error.code ? error.message : 'Booking failed.', { operation_id: op.id, state, ...(error.details ?? {}) });
  }
}
