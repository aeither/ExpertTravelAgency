import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const token = readFileSync('.data/masumi-platform-key', 'utf8').trim();
const headers = { Authorization: `Bearer ${token}` };
const completion = await fetch('https://app.masumi.network/api/agents/dadcc8f0-8f91-48e8-b9f0-b420ad73199b/complete-registration', {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(25000),
});
if (!completion.ok) throw new Error(`Registration completion HTTP ${completion.status}`);
const response = await fetch('https://app.masumi.network/api/agents/dadcc8f0-8f91-48e8-b9f0-b420ad73199b', { headers, signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Masumi HTTP ${response.status}`);
const body = await response.json() as any;
writeFileSync('.data/masumi-registration-detail.json', JSON.stringify(body, null, 2), { mode: 0o600 });
const agent = body.data;
console.log(`Registration: ${agent.registrationState}; verification: ${agent.verificationStatus}`);
if (agent.registrationState !== 'RegistrationConfirmed' || !agent.agentIdentifier) {
  console.log('Masumi registration remains pending; no deployment settings changed.');
  process.exit(2);
}
const vars = { MASUMI_URL: 'https://app.masumi.network/pay/api/v1', MASUMI_TOKEN: token, MASUMI_AGENT_IDENTIFIER: agent.agentIdentifier };
const envPath = '.env.local';
let envText = readFileSync(envPath, 'utf8');
for (const [key, value] of Object.entries(vars)) {
  envText = envText.replace(new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'gm'), '');
  envText += `\n${key}=${value}\n`;
  const result = spawnSync('vercel', ['env', 'add', key, 'production', '--force', '--yes'], { input: value, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not configure Vercel ${key}`);
  console.log(`Configured ${key}`);
}
writeFileSync(envPath, envText, { mode: 0o600 });
console.log(`Agent identifier: ${agent.agentIdentifier}`);
console.log('Run vercel deploy --prod --yes to activate the configuration.');
