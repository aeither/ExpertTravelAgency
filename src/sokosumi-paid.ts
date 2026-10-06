import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { sha256 } from './store.js';

const MINUTE = 60000;
// Input is one string field, so JSON.stringify of that object is canonical (MIP-003 hashing, not a bare SHA-256 of the prompt).
export const taskInputHash = (input: string, nonce: string) => sha256(`${nonce};${JSON.stringify({ prompt: input })}`);
export const taskResultHash = (result: string, nonce: string) => sha256(`${nonce};${result}`);

export const confirmedState = (payment: any, expected: string) =>
  (payment.onChainState === expected) && [payment.CurrentTransaction, ...(payment.TransactionHistory ?? [])].some(t => t?.status === 'Confirmed' && t.newOnChainState === expected);

export const txFor = (payment: any, state: string): string | null =>
  [payment.CurrentTransaction, ...(payment.TransactionHistory ?? [])].find(t => t?.status === 'Confirmed' && t.newOnChainState === state && t.txHash)?.txHash ?? null;

// Core's task event takes the seller's signed terms unchanged. It cannot carry non-null signed overrides.
export function purchasePayload(payment: any, nonce: string, config: Config) {
  if (payment.sellerReturnAddress != null || payment.forceLayer != null) throw new ApiError(409, 'PAID_TERMS_UNSUPPORTED', 'Core task events cannot preserve a signed sellerReturnAddress or forceLayer. Configure seller defaults and request fresh terms.');
  if (payment.PaymentSource?.network !== 'Preprod' || payment.PaymentSource?.paymentSourceType !== 'Web3CardanoV2') throw new ApiError(409, 'PAID_TERMS_MISMATCH', 'Payment source is not Preprod Web3CardanoV2.');
  const funds = payment.RequestedFunds;
  if (!Array.isArray(funds) || funds.length !== 1 || funds[0].unit !== config.MASUMI_TOKEN_UNIT || funds[0].amount !== config.MASUMI_PRICE_ATOMIC) throw new ApiError(409, 'PAID_TERMS_MISMATCH', 'Signed quote differs from the configured price.');
  if (payment.agentIdentifier !== config.MASUMI_AGENT_IDENTIFIER || typeof payment.SmartContractWallet?.walletVkey !== 'string') throw new ApiError(409, 'PAID_TERMS_MISMATCH', 'Signed terms name another agent or seller.');
  return {
    blockchainIdentifier: payment.blockchainIdentifier, agentIdentifier: payment.agentIdentifier, sellerVkey: payment.SmartContractWallet.walletVkey,
    submitResultTime: payment.submitResultTime, payByTime: payment.payByTime, unlockTime: payment.unlockTime, externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
    inputHash: payment.inputHash, identifierFromPurchaser: nonce, paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: config.MASUMI_SUPPORTED_SOURCE_INDEX,
    Amounts: funds.map(({ amount, unit }: any) => ({ amount, unit })),
    PaymentSource: { network: 'Preprod', smartContractAddress: payment.PaymentSource.smartContractAddress, policyId: payment.PaymentSource.policyId },
  };
}

const EXPLORER = 'https://preprod.cexplorer.io';
const link = (label: string, tx: string | null | undefined) => tx ? `- ${label}: ${EXPLORER}/tx/${tx}` : undefined;
// Plain text, so Sokosumi shows it as-is. Every link is public chain data a user can open without trusting us.
export function proofBlock(paid: any, config: Config) {
  const usdm = Number(config.MASUMI_PRICE_ATOMIC) / 1e6;
  return ['', '---', `Payment proof (Cardano Preprod, real transactions, ${usdm} test USDM):`,
    link('1. Your payment locked in escrow', paid.escrowTx), link('2. My result hash submitted on-chain', paid.resultTx),
    '3. Seller payout: posted here as a comment once the escrow unlocks and is collected.',
    `- Escrow contract: ${EXPLORER}/address/${paid.payment?.PaymentSource?.smartContractAddress}`,
    `- Agent registration (policy): ${EXPLORER}/policy/${paid.payment?.PaymentSource?.policyId}`].filter(Boolean).join('\n');
}
export const collectionComment = (paid: any, config: Config) => ['Payout collected on-chain. The seller received the escrowed test USDM:', link('Seller payout transaction', paid.withdrawalTx),
  `Anyone can check it: open the link and look for ${Number(config.MASUMI_PRICE_ATOMIC) / 1e6} USDM minus the protocol fee arriving at the seller address.`].filter(Boolean).join('\n');

export type PaidDeps = {
  config: Config;
  // Calls the payment node (MPS). Throws on any failure.
  mps: (path: string, body: unknown) => Promise<any>;
  // Writes a task event as the assigned Coworker.
  event: (taskId: string, body: unknown) => Promise<any>;
  save: () => Promise<void>;
};

// Each call moves one stage and persists before and after every external write. A *-pending stage is never retried blindly.
// The paid sequence: quote -> masumiPayment event -> confirmed escrow -> work -> result hash -> completion -> collection.
export class PaidFlow {
  constructor(private d: PaidDeps) {}
  private async persist(state: any, paid: any) { state.paid = paid; await this.d.save(); }

  // Returns 'ready' when escrow is confirmed and work may begin, otherwise 'waiting'.
  async beforeWork(task: any, state: any): Promise<'ready' | 'waiting'> {
    const { config } = this.d;
    let p = state.paid ?? {};
    if (!p.stage) {
      if (!state.input?.trim()) throw new ApiError(409, 'PAID_NO_INPUT', 'A paid task needs its started input.');
      const nonce = randomBytes(10).toString('hex'), now = Date.now();
      const request = {
        network: 'Preprod', agentIdentifier: config.MASUMI_AGENT_IDENTIFIER, paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: config.MASUMI_SUPPORTED_SOURCE_INDEX,
        inputHash: taskInputHash(state.input, nonce), identifierFromPurchaser: nonce, RequestedFunds: [{ amount: config.MASUMI_PRICE_ATOMIC, unit: config.MASUMI_TOKEN_UNIT }],
        payByTime: new Date(now + 10 * MINUTE).toISOString(), submitResultTime: new Date(now + 25 * MINUTE).toISOString(),
        unlockTime: new Date(now + 40 * MINUTE).toISOString(), externalDisputeUnlockTime: new Date(now + 55 * MINUTE).toISOString(),
        metadata: JSON.stringify({ taskId: task.id }),
      };
      p = { stage: 'terms-pending', nonce, request }; await this.persist(state, p);
      const payment = await this.d.mps('/payment', request);
      p = { ...p, stage: 'terms-saved', payment }; await this.persist(state, p);
    }
    if (p.stage === 'terms-saved') {
      const payload = purchasePayload(p.payment, p.nonce, config);
      if (Date.now() >= Number(p.payment.payByTime)) throw new ApiError(409, 'PAID_TERMS_EXPIRED', 'Signed payment deadline passed before the buyer paid.');
      p = { ...p, payload, stage: 'purchase-pending' }; await this.persist(state, p);
      const response = await this.d.event(task.id, { comment: `Payment requested: ${Number(config.MASUMI_PRICE_ATOMIC) / 1e6} test USDM.`, masumiPayment: payload });
      p = { ...p, stage: 'awaiting-escrow', purchaseEventId: response.data?.id ?? null }; await this.persist(state, p);
    }
    if (p.stage === 'awaiting-escrow') {
      const observed = await this.observe(p);
      p = { ...p, observed: this.brief(observed) }; await this.persist(state, p);
      if (!confirmedState(observed, 'FundsLocked')) {
        if (Date.now() > Number(p.payment.submitResultTime)) throw new ApiError(409, 'PAID_ESCROW_EXPIRED', 'Escrow was not funded before the result deadline.');
        return 'waiting';
      }
      p = { ...p, stage: 'escrow-confirmed', escrowTx: txFor(observed, 'FundsLocked') }; await this.persist(state, p);
    }
    if (p.stage === 'terms-pending' || p.stage === 'purchase-pending') throw new ApiError(409, 'PAID_UNCERTAIN', `Uncertain ${p.stage}. Inspect the prior operation before recovery; automatic retry is disabled.`);
    return 'ready';
  }

  // After the answer is saved: submit its hash, wait for the confirmed result transaction. Returns true when the task may be completed.
  async afterWork(task: any, state: any): Promise<'complete' | 'waiting'> {
    let p = state.paid;
    if (p.stage === 'escrow-confirmed') {
      if (Date.now() >= Number(p.payment.submitResultTime)) throw new ApiError(409, 'PAID_RESULT_EXPIRED', 'Result deadline passed before the hash was submitted.');
      const resultHash = taskResultHash(state.answer, p.nonce);
      p = { ...p, resultHash, stage: 'submit-pending' }; await this.persist(state, p);
      await this.d.mps('/payment/submit-result', { network: 'Preprod', blockchainIdentifier: p.payment.blockchainIdentifier, submitResultHash: resultHash });
      p = { ...p, stage: 'awaiting-result' }; await this.persist(state, p);
    }
    if (p.stage === 'awaiting-result') {
      const observed = await this.observe(p);
      if (observed.resultHash === p.resultHash && confirmedState(observed, 'ResultSubmitted')) { p = { ...p, stage: 'result-confirmed', resultTx: txFor(observed, 'ResultSubmitted') }; await this.persist(state, p); }
      else { p = { ...p, observed: this.brief(observed) }; await this.persist(state, p); return 'waiting'; }
    }
    if (p.stage === 'submit-pending') throw new ApiError(409, 'PAID_UNCERTAIN', 'Uncertain result submission. Inspect it before recovery; automatic retry is disabled.');
    return p.stage === 'result-confirmed' ? 'complete' : 'waiting';
  }

  // After completion: follow collection until the node reports it. Seller receipt is a separate on-chain check (npm run verify:receipt).
  async collection(state: any): Promise<'settled' | 'waiting'> {
    let p = state.paid;
    if (p.stage === 'settled') return 'settled';
    const observed = await this.observe(p);
    p = { ...p, observed: this.brief(observed) };
    if (['Withdrawn', 'DisputedWithdrawn'].includes(observed.onChainState) && confirmedState(observed, observed.onChainState)) {
      p = { ...p, stage: 'settled', withdrawalTx: txFor(observed, observed.onChainState), settledState: observed.onChainState };
      await this.persist(state, p); return 'settled';
    }
    await this.persist(state, p); return 'waiting';
  }

  private observe(p: any) { return this.d.mps('/payment/resolve-blockchain-identifier', { network: 'Preprod', blockchainIdentifier: p.payment.blockchainIdentifier, includeHistory: 'true' }); }
  private brief(o: any) { return { onChainState: o.onChainState, resultHash: o.resultHash ?? null, nextAction: o.NextAction?.requestedAction ?? null, at: new Date().toISOString() }; }
}
