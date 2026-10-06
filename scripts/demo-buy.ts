// Buyer agent for the demo: hire the travel agent, pay through escrow, verify the proof.
//   npm run demo:buy                         # uses the hosted API; rehearsal or live follows the server
//   npm run demo:buy -- --base http://127.0.0.1:3026 --route LHR-CDG:Paris:FR
// Live settlement needs a Masumi Payment Service that has a funded purchasing wallet:
//   BUYER_PAYMENT_URL=http://127.0.0.1:3012/api/v1  BUYER_PAYMENT_TOKEN=<key>
import { createHash, randomBytes } from 'node:crypto';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const base = arg('base', process.env.BASE_URL ?? 'https://origin-travel-agent.vercel.app').replace(/\/$/, '');
const [route, cityName, countryCode] = arg('route', 'SIN-BKK:Bangkok:TH').split(':');
const [origin, destination] = route.split('-');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const t0 = Date.now();
const log = (step: string, detail = '') => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${step}${detail ? '  ' + detail : ''}`);
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data?.error?.code ?? ''} ${data?.error?.message ?? ''}`.trim());
  return data;
}

async function payOnChain(job: any) {
  const url = process.env.BUYER_PAYMENT_URL, token = process.env.BUYER_PAYMENT_TOKEN;
  if (!url || !token) throw new Error('Live settlement needs BUYER_PAYMENT_URL and BUYER_PAYMENT_TOKEN (a Masumi Payment Service with a funded purchasing wallet).');
  // Field names follow the Payment Service /purchase schema; unverified until a buyer wallet is available.
  const response = await fetch(url.replace(/\/$/, '') + '/purchase', {
    method: 'POST', headers: { 'content-type': 'application/json', token },
    body: JSON.stringify({
      identifierFromPurchaser: job.identifierFromPurchaser, network: 'Preprod', sellerVkey: job.sellerVKey, paymentType: 'Web3CardanoV2',
      blockchainIdentifier: job.blockchainIdentifier, payByTime: String(job.payByTime), submitResultTime: String(job.submitResultTime),
      unlockTime: String(job.unlockTime), externalDisputeUnlockTime: String(job.externalDisputeUnlockTime),
      agentIdentifier: job.agentIdentifier, inputHash: job.input_hash,
    }),
  });
  if (!response.ok) throw new Error(`Purchase rejected: HTTP ${response.status}`);
}

try {
  log('Checking the agent', base);
  const caps = await api('/v1/capabilities');
  const mode = caps.masumi?.mode;
  if (mode === 'unconfigured') throw new Error('The agent has no payment service configured yet.');
  log('Settlement', mode === 'simulated' ? 'SIMULATED rehearsal, no real funds' : 'Cardano Preprod escrow');

  const request = {
    flights: { slices: [{ origin, destination, departure_date: day(30) }], passengers: [{ type: 'adult' }], max_connections: 1 },
    stays: { check_in_date: day(30), check_out_date: day(33), rooms: [{ adults: 1 }], location: { city: cityName, country_code: countryCode }, currency: 'EUR', limit: 10 },
  };
  const input = { trip_request_json: JSON.stringify(request) };
  const nonce = randomBytes(10).toString('hex');
  const job = await api('/start_job', { identifier_from_purchaser: nonce, input_data: input });
  log('Payment terms received', `${Number(caps.masumi.price_atomic) / 1e6} USDM, escrow ${String(job.blockchainIdentifier).slice(0, 18)}…`);
  if (sha256(`${nonce};${JSON.stringify(input)}`) !== job.input_hash) throw new Error('The agent quoted terms for a different request. Not paying.');
  log('Terms bound to my exact request', 'input hash matches');

  if (job.settlement === 'simulated') { await api('/v1/demo/simulate-payment', { job_id: job.id }); log('Escrow funded', 'simulated'); }
  else { await payOnChain(job); log('Purchase submitted', 'waiting for FundsLocked on Cardano'); }

  let status: any, phase = '';
  for (let i = 0; i < 200; i++) {
    status = await api(`/status?job_id=${job.id}`);
    if (status.phase !== phase) { phase = status.phase; log('Agent phase', `${status.phase} (${status.payment_state ?? 'no payment yet'})`); }
    if (status.status === 'completed') break;
    if (status.status === 'failed') throw new Error(`Job failed: ${status.error ?? status.phase}`);
    await new Promise(r => setTimeout(r, 2000));
  }
  if (status?.status !== 'completed') throw new Error('Timed out waiting for the result.');

  const resultOk = sha256(`${nonce};${status.result}`) === status.result_hash;
  log('Verifying proof', resultOk ? 'result hash matches what the agent committed to' : 'MISMATCH');
  if (!resultOk) throw new Error('Result hash mismatch. A real buyer would request a refund.');
  if (status.transactions?.payment) log('Payment reference', status.transactions.payment);
  if (status.transactions?.result) log('Result reference', status.transactions.result);

  const summary = JSON.parse(status.result).summary ?? {};
  const f = summary.flights?.cheapest, fast = summary.flights?.fastest, h = summary.hotels?.top_rated?.[0];
  console.log('\n=== Delivered trip ===');
  if (f) console.log(`Cheapest flight : ${f.airline} ${f.route}  ${f.total.currency} ${f.total.amount}  (${f.stops ? f.stops + ' stop' : 'nonstop'})`);
  if (fast) console.log(`Fastest flight  : ${fast.airline}  ${Math.floor(fast.duration_minutes / 60)}h${fast.duration_minutes % 60}m  ${fast.total.currency} ${fast.total.amount}`);
  if (h) console.log(`Top-rated hotel : ${h.name} (${h.stars ?? '?'}★)  ${h.total.currency} ${h.total.amount}  ${h.refundable ? 'free cancellation' : 'non-refundable'}`);
  if (summary.estimated_total?.amount) console.log(`Estimated total : ${summary.estimated_total.currency} ${summary.estimated_total.amount} (${summary.estimated_total.basis})`);
  log('Done');
} catch (error: any) {
  log('FAILED', error.message);
  process.exitCode = 1;
}
