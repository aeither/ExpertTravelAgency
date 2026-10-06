// Independent seller-receipt check: reads a confirmed Cardano Preprod transaction from Blockfrost and measures the
// seller wallet's net test USDM (outputs to the seller minus inputs from the seller). It trusts nothing from the payment node.
// Usage: npm run verify:receipt -- <txHash> <sellerAddress> [unit]
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const [tx, seller, unit = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'] = process.argv.slice(2);
const key = process.env.BLOCKFROST_API_KEY_PREPROD;
if (!/^[a-f0-9]{64}$/.test(tx ?? '') || !/^addr_test1[0-9a-z]+$/.test(seller ?? '') || !key) throw new Error('Usage: verify:receipt <txHash> <addr_test1…> [unit]; BLOCKFROST_API_KEY_PREPROD required.');
const get = async (path: string) => { const r = await fetch(`https://cardano-preprod.blockfrost.io/api/v0${path}`, { headers: { project_id: key }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`Blockfrost ${path}: HTTP ${r.status}`); return r.json() as Promise<any>; };
const [info, utxos] = await Promise.all([get(`/txs/${tx}`), get(`/txs/${tx}/utxos`)]);
const sum = (side: any[]) => side.filter(o => o.address === seller).reduce((n, o) => n + BigInt(o.amount.find((a: any) => a.unit === unit)?.quantity ?? 0), 0n);
const received = sum(utxos.outputs), spent = sum(utxos.inputs), net = received - spent;
console.log(JSON.stringify({
  tx, explorer: `https://preprod.cexplorer.io/tx/${tx}`, confirmed: info.block != null, block: info.block, block_time: new Date(info.block_time * 1000).toISOString(),
  seller, unit, outputs_to_seller_atomic: received.toString(), inputs_from_seller_atomic: spent.toString(), net_received_atomic: net.toString(), net_received_usdm: Number(net) / 1e6,
}, null, 2));
if (info.block == null || net <= 0n) { console.error('NOT VERIFIED: transaction unconfirmed or seller gained no USDM.'); process.exit(2); }
