import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { ApiError, unavailable } from './errors.js';
import { HttpClient } from './http.js';
import { sha256, type Storage } from './store.js';
import { tripSearch } from './schemas.js';
import { Travel } from './travel.js';

export const startJobSchema = z.object({
  identifier_from_purchaser: z.string().regex(/^[a-f0-9]{14,26}$/),
  input_data: z.object({ trip_request_json: z.string().min(2).max(16000) }).strict(),
}).strict();
export const masumiInputHash = (input: { trip_request_json: string }, nonce: string) => sha256(`${nonce};${JSON.stringify({ trip_request_json: input.trip_request_json })}`);
export const masumiResultHash = (result: string, nonce: string) => sha256(`${nonce};${result}`);
export const SIMULATED_AGENT = `simulated-${'0'.repeat(56)}`;
export const inputSchema = { input_data: [{ id: 'trip_request_json', type: 'string', name: 'Travel search request', data: { description: 'JSON body for POST /v1/trips/search. Supplier prices use fiat currencies.' }, validations: [{ validation: 'min', value: '2' }, { validation: 'max', value: '16000' }] }] };

export class Masumi {
  private active = new Set<string>();
  constructor(private config: Config, private http: HttpClient, private store: Storage, private travel: Travel) {}
  get simulated() { return this.config.MASUMI_MODE === 'simulated'; }
  get configured() { return this.simulated || (!!this.config.MASUMI_TOKEN && this.config.MASUMI_AGENT_IDENTIFIER.length >= 57); }
  private get agentId() { return this.simulated ? SIMULATED_AGENT : this.config.MASUMI_AGENT_IDENTIFIER; }
  private async call(path: string, body?: unknown) {
    if (!this.configured) unavailable('Masumi Payment Service', 'MASUMI_TOKEN and MASUMI_AGENT_IDENTIFIER');
    const headers: Record<string, string> = new URL(this.config.MASUMI_URL).hostname === 'app.masumi.network'
      ? { Authorization: `Bearer ${this.config.MASUMI_TOKEN}` }
      : { token: this.config.MASUMI_TOKEN };
    const response = await this.http.request(this.config.MASUMI_URL, path, headers, body);
    if (response?.data === undefined) throw new ApiError(502, 'MASUMI_INVALID_RESPONSE', 'Masumi did not return data.', undefined, true);
    return response.data;
  }
  async health() {
    if (this.simulated) return { configured: true, settlement: 'simulated', network: 'Preprod', onchain_verified: false };
    if (!this.configured) return { configured: false, network: 'Preprod', onchain_verified: false };
    await this.call('/health');
    return { configured: true, node_reachable: true, network: 'Preprod', onchain_verified: false };
  }
  async start(input: z.infer<typeof startJobSchema>) {
    if (!this.configured) unavailable('Masumi Payment Service', 'MASUMI_TOKEN and MASUMI_AGENT_IDENTIFIER');
    // Paid jobs cannot use synthetic travel data.
    if (this.travel.isDemo) throw new ApiError(409, 'PAID_DEMO_DISABLED', 'Use TRAVEL_MODE=live for paid Masumi searches.');
    let request;
    try { request = tripSearch.parse(JSON.parse(input.input_data.trip_request_json)); }
    catch { throw new ApiError(400, 'INVALID_TRIP_REQUEST', 'trip_request_json must contain a valid /v1/trips/search body.'); }
    const needed = this.travel.capabilities();
    if ((request.flights && !needed.flights.credentials_present) || (request.stays && !needed.stays.credentials_present)) {
      throw new ApiError(503, 'SEARCH_PROVIDER_NOT_CONFIGURED', 'Configure each requested search provider before creating a paid job.');
    }
    const nonce = input.identifier_from_purchaser;
    const hash = masumiInputHash(input.input_data, nonce);
    const existing = await this.store.jobByNonce(nonce);
    if (existing) {
      if (existing.inputHash !== hash) throw new ApiError(409, 'NONCE_CONFLICT', 'This purchaser nonce belongs to another input.');
      if (!existing.response) throw new ApiError(409, 'PAYMENT_OUTCOME_UNKNOWN', 'Inspect the saved payment request before retrying.', { job_id: existing.id });
      return existing.response;
    }
    const job: any = { id: randomUUID(), nonce, inputHash: hash, input: input.input_data, request, status: 'awaiting_payment', phase: 'terms_pending' };
    await this.store.saveJob(job);
    const now = Date.now(), minute = 60000;
    let payment: any;
    try {
      payment = await this.createPayment({
        network: 'Preprod', paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: this.config.MASUMI_SUPPORTED_SOURCE_INDEX,
        agentIdentifier: this.agentId, inputHash: hash, identifierFromPurchaser: nonce,
        RequestedFunds: [{ amount: this.config.MASUMI_PRICE_ATOMIC, unit: this.config.MASUMI_TOKEN_UNIT }],
        payByTime: new Date(now + 10 * minute).toISOString(), submitResultTime: new Date(now + 20 * minute).toISOString(),
        unlockTime: new Date(now + 36 * minute).toISOString(), externalDisputeUnlockTime: new Date(now + 52 * minute).toISOString(),
      });
      job.payment = payment;
      await this.store.saveJob(job);
      this.validateTerms(payment, hash);
    } catch (error) {
      job.phase = 'terms_require_inspection'; job.status = 'failed'; await this.store.saveJob(job); throw error;
    }
    job.phase = 'waiting_payment';
    job.response = {
      id: job.id, blockchainIdentifier: payment.blockchainIdentifier, agentIdentifier: payment.agentIdentifier,
      input_hash: hash, identifierFromPurchaser: nonce, settlement: this.simulated ? 'simulated' : 'onchain', sellerVKey: payment.SmartContractWallet.walletVkey,
      payByTime: Number(payment.payByTime), submitResultTime: Number(payment.submitResultTime),
      unlockTime: Number(payment.unlockTime), externalDisputeUnlockTime: Number(payment.externalDisputeUnlockTime),
      paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: this.config.MASUMI_SUPPORTED_SOURCE_INDEX,
      // Keep the terms from MPS intact. The future buyer must preserve all signed fields.
      payment_request: payment,
    };
    await this.store.saveJob(job); return job.response;
  }
  private async createPayment(body: any) {
    if (!this.simulated) return this.call('/payment', body);
    // Rehearsal terms: same shape as the Payment Service returns, but nothing touches a chain.
    return {
      blockchainIdentifier: `sim_${randomBytes(24).toString('hex')}`, agentIdentifier: SIMULATED_AGENT, inputHash: body.inputHash,
      identifierFromPurchaser: body.identifierFromPurchaser, RequestedFunds: body.RequestedFunds,
      payByTime: String(Date.parse(body.payByTime)), submitResultTime: String(Date.parse(body.submitResultTime)),
      unlockTime: String(Date.parse(body.unlockTime)), externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)),
      SmartContractWallet: { walletVkey: `sim${sha256(SIMULATED_AGENT).slice(0, 53)}` },
      PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2' },
      onChainState: null, CurrentTransaction: null, TransactionHistory: [],
    };
  }
  // Rehearsal buyer: marks the escrow as funded. Only available in simulated mode.
  async simulatePayment(id: string) {
    if (!this.simulated) throw new ApiError(409, 'SIMULATION_DISABLED', 'Simulated payments are only available when MASUMI_MODE=simulated.');
    await this.store.withJobLock(id, async () => {
      const job = await this.store.job(id);
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
      if (job.phase !== 'waiting_payment') throw new ApiError(409, 'JOB_NOT_AWAITING_PAYMENT', 'This job is not waiting for payment.', { phase: job.phase });
      if (Date.now() > Number(job.payment.payByTime)) throw new ApiError(409, 'PAYMENT_DEADLINE_PASSED', 'The payment deadline has passed. Start a new job.');
      job.sim = { paid: true, payTx: `sim-${randomBytes(16).toString('hex')}` };
      await this.store.saveJob(job);
    });
    return { job_id: id, settlement: 'simulated', payment_state: 'FundsLocked' };
  }
  private simResolve(job: any) {
    const tx = (hash: string, state: string) => ({ status: 'Confirmed', newOnChainState: state, txHash: hash });
    const sim = job.sim ?? {};
    const history: any[] = [];
    if (sim.paid) history.push(tx(sim.payTx, 'FundsLocked'));
    if (sim.resultHash) history.push(tx(sim.resultTx, 'ResultSubmitted'));
    const current = history.at(-1) ?? null;
    return { ...job.payment, onChainState: current?.newOnChainState ?? null, resultHash: sim.resultHash ?? null, CurrentTransaction: current, TransactionHistory: history };
  }
  private txFor(payment: any, state: string): string | null {
    return [payment.CurrentTransaction, ...(payment.TransactionHistory ?? [])].find(t => t?.newOnChainState === state && t.txHash)?.txHash ?? null;
  }
  private validateTerms(p: any, hash: string) {
    const funds = p.RequestedFunds;
    const deadlines = [p.payByTime, p.submitResultTime, p.unlockTime, p.externalDisputeUnlockTime].map(Number);
    if (p.PaymentSource?.network !== 'Preprod' || p.PaymentSource?.paymentSourceType !== 'Web3CardanoV2' || p.agentIdentifier !== this.agentId || p.inputHash !== hash ||
      typeof p.blockchainIdentifier !== 'string' || !p.blockchainIdentifier || typeof p.SmartContractWallet?.walletVkey !== 'string' || !p.SmartContractWallet.walletVkey ||
      !Array.isArray(funds) || funds.length !== 1 || funds[0].amount !== this.config.MASUMI_PRICE_ATOMIC || funds[0].unit !== this.config.MASUMI_TOKEN_UNIT ||
      deadlines.some((d, i) => !Number.isFinite(d) || d <= Date.now() || (i > 0 && d <= deadlines[i - 1]))) {
      throw new ApiError(502, 'MASUMI_TERMS_MISMATCH', 'The payment terms do not match the configured Preprod search service.');
    }
  }
  async status(id: string, advance = false) {
    if (advance) await this.store.withJobLock(id, async () => {
      const current = await this.store.job(id);
      if (current?.payment && !['completed', 'failed'].includes(current.status)) await this.process(current);
    });
    const job = await this.store.job(id);
    if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
    return { status: job.status, ...(job.status === 'completed' ? { result: job.result } : {}), phase: job.phase,
      ...(job.error ? { error: job.error } : {}), payment_state: job.paymentState ?? null, seller_receipt_verified: false,
      settlement: this.simulated ? 'simulated' : 'onchain', input_hash: job.inputHash, result_hash: job.resultHash ?? null,
      transactions: { payment: job.tx?.payment ?? null, result: job.tx?.result ?? null } };
  }
  private confirmed(payment: any, state: string) {
    return payment.onChainState === state && ([payment.CurrentTransaction, ...(payment.TransactionHistory ?? [])].some(t => t?.status === 'Confirmed' && t.newOnChainState === state));
  }
  async tick(limit = 20) {
    for (const job of (await this.store.pendingJobs()).slice(0, limit)) {
      if (!job.payment || this.active.has(job.id)) continue;
      this.active.add(job.id);
      try { await this.store.withJobLock(job.id, async () => { const current = await this.store.job(job.id); if (current && !['completed', 'failed'].includes(current.status)) await this.process(current); }); }
      catch (error: any) {
        // Keep the exact phase for inspection. Never replay a payment or result write.
        const current = await this.store.job(job.id); if (current) { current.error = error.code ?? 'JOB_FAILED'; await this.store.saveJob(current); }
      } finally { this.active.delete(job.id); }
    }
  }
  private async process(job: any) {
    if (!['waiting_payment', 'awaiting_result', 'submit_pending'].includes(job.phase)) {
      job.error = 'RESTART_REQUIRES_INSPECTION'; await this.store.saveJob(job); return;
    }
    const payment = this.simulated ? this.simResolve(job) : await this.call('/payment/resolve-blockchain-identifier', { network: 'Preprod', blockchainIdentifier: job.payment.blockchainIdentifier, includeHistory: 'true' });
    job.paymentState = payment.onChainState;
    job.tx = { payment: this.txFor(payment, 'FundsLocked'), result: this.txFor(payment, 'ResultSubmitted') };
    if (['awaiting_result', 'submit_pending'].includes(job.phase)) {
      if (payment.resultHash === job.resultHash && this.confirmed(payment, 'ResultSubmitted')) { job.phase = 'result_confirmed'; job.status = 'completed'; delete job.error; }
      await this.store.saveJob(job); return;
    }
    if (!this.confirmed(payment, 'FundsLocked')) {
      if (Date.now() > Number(job.payment.submitResultTime)) { job.status = 'failed'; job.phase = 'deadline_expired'; }
      await this.store.saveJob(job); return;
    }
    if (Date.now() + this.config.UPSTREAM_TIMEOUT_MS + 30000 >= Number(job.payment.submitResultTime)) { job.status = 'failed'; job.phase = 'deadline_expired'; await this.store.saveJob(job); return; }
    job.phase = 'search_pending'; job.status = 'running'; await this.store.saveJob(job);
    const result = await this.travel.trip(job.request);
    // A partial supplier failure must not be sold as a completed paid search.
    if (!result.complete) { job.phase = 'supplier_failed'; job.status = 'failed'; job.error = 'SEARCH_INCOMPLETE'; await this.store.saveJob(job); return; }
    job.result = JSON.stringify(result); job.resultHash = masumiResultHash(job.result, job.nonce);
    job.phase = 'submit_pending'; await this.store.saveJob(job);
    if (Date.now() >= Number(job.payment.submitResultTime)) { job.status = 'failed'; job.phase = 'deadline_expired'; await this.store.saveJob(job); return; }
    if (this.simulated) job.sim = { ...job.sim, resultHash: job.resultHash, resultTx: `sim-${randomBytes(16).toString('hex')}` };
    else await this.call('/payment/submit-result', { network: 'Preprod', blockchainIdentifier: job.payment.blockchainIdentifier, submitResultHash: job.resultHash });
    job.phase = 'awaiting_result'; await this.store.saveJob(job);
  }
}
