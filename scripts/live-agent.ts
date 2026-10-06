import { getConfig } from '../src/config.js';
import { HttpClient } from '../src/http.js';
import { Travel } from '../src/travel.js';
import { Store } from '../src/store.js';
import { runAgent } from '../src/agent.js';
const config = getConfig({ ...process.env, ADVISOR_URL: 'https://expert-travel-advisor.vercel.app', SOKOSUMI_PAID: 'true' });
const travel = new Travel(config, new HttpClient(config.UPSTREAM_TIMEOUT_MS));
const store = new Store(':memory:'); const deps = { travel, store, config };
console.log('model:', config.OPENROUTER_MODEL, '| key set:', !!config.OPENROUTER_API_KEY);
for (const prompt of process.argv.slice(2)) {
  const t = Date.now();
  try { const d = await runAgent(prompt, deps, 'live'); console.log(`\n=== "${prompt}" (${Math.round((Date.now() - t) / 1000)}s) -> ${d.kind}\n${d.text}`); }
  catch (e: any) { console.log(`\n=== "${prompt}" FAILED after ${Math.round((Date.now() - t) / 1000)}s:`, String(e?.message ?? e).slice(0, 400)); }
}
