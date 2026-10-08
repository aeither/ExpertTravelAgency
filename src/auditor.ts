import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { modelFor } from './agent.js';

// The Trip Auditor: another agent checks a draft travel plan against the evidence its author collected.
// Rules come first (they are deterministic and cannot be talked round). An optional model pass checks named places.
export const auditRequestSchema = z.object({
  plan_text: z.string().trim().min(1).max(12000),
  constraints: z.object({
    nights: z.number().int().min(1).max(30), adults: z.number().int().min(1).max(9),
    children_ages: z.array(z.number().int().min(0).max(17)).max(8).optional(),
    budget_per_night: z.number().positive().max(1_000_000).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  }).strict(),
  evidence: z.object({
    hotels: z.array(z.object({ name: z.string().min(1).max(200), total: z.number().nonnegative(), nightly: z.number().nonnegative().optional(), currency: z.string().regex(/^[A-Z]{3}$/), free_cancellation: z.boolean().optional(), source: z.string().max(40).optional() }).strict()).max(30),
    flights: z.array(z.object({ summary: z.string().max(400), total: z.number().nonnegative().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict()).max(20).optional(),
    knowledge: z.array(z.string().max(4000)).max(10).optional(),
  }).strict(),
}).strict();
export type AuditRequest = z.infer<typeof auditRequestSchema>;
export type Claim = { claim: string; status: 'supported' | 'unsupported' | 'unverifiable'; note?: string };
export interface AuditResult {
  verdict: 'pass' | 'revise'; summary: string;
  checks: { hotels_known: boolean; prices_match: boolean; budget_ok: boolean; occupancy_stated: boolean; places_grounded: boolean };
  claims: Claim[]; rewrite_hints: string[]; audited_at: string; method: 'rules' | 'rules+model';
}

const norm = (t: string) => t.toLowerCase().replace(/[*_`#>]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const MAX_CLAIMS = 20;

// Money figures written as "330 USD", "USD 330", "$330" or "330 dollars". Years, dates and ages are not money.
function moneyFigures(text: string, currency: string): number[] {
  const out: number[] = [];
  const code = '(?:USD|EUR|GBP|SGD|PHP|THB|IDR|[A-Z]{3})';
  const re = new RegExp(`(?:(?:US)?\\$|€|£)\\s?(\\d[\\d,]*(?:\\.\\d+)?)|(\\d[\\d,]*(?:\\.\\d+)?)\\s?(?:${code}|dollars?)\\b|\\b${code}\\s?(\\d[\\d,]*(?:\\.\\d+)?)`, 'g');
  for (const m of text.matchAll(re)) { const n = Number((m[1] ?? m[2] ?? m[3]).replace(/,/g, '')); if (Number.isFinite(n) && n > 0) out.push(n); }
  void currency; return out;
}

// Hotel names the plan puts in bold, or after "pick", "alternative", "stay at".
function namedHotels(text: string): string[] {
  const found = new Set<string>();
  // A bold "Label:" (Hotel total:, Rating:, Free cancellation:) names a field, not a hotel.
  for (const m of text.matchAll(/\*\*([^*\n]{3,80})\*\*/g)) { const name = m[1]!.trim(); if (!name.endsWith(':')) found.add(name); }
  for (const m of text.matchAll(/(?:top pick|alternatives?|stay at|stay in|book(?:ing)?|option)\s*[:\-]?\s*(?:\*\*)?([A-Z][\p{L}\p{N}'&.\- ]{2,70}?)(?:\*\*|,|\.|\s[—–-]\s|\s\(|\sfor\s|\sat\s|$|\n)/gmu)) found.add(m[1]!.trim());
  return [...found];
}

function occupancyStated(text: string, c: AuditRequest['constraints']): boolean {
  const t = norm(text), kids = c.children_ages ?? [];
  if (!kids.length) return true;
  const kidWord = /\b(kids?|child|children|boys?|girls?|toddlers?)\b/.test(t);
  const count = new RegExp(`\\b(${kids.length}|${Object.entries(NUMBER_WORDS).find(([, n]) => n === kids.length)?.[0] ?? 'zzz'})\\s+(kids?|children|child)\\b`).test(t);
  const ages = kids.some(a => new RegExp(`\\b${a}\\b`).test(t));
  return kidWord && (count || ages);
}

export function auditRules(request: AuditRequest) {
  const { plan_text, constraints, evidence } = request;
  const claims: Claim[] = [], hints: string[] = [];
  const known = evidence.hotels.map(h => ({ ...h, key: norm(h.name) }));
  const mentioned = namedHotels(plan_text);
  let hotelsKnown = true;
  for (const name of mentioned) {
    const key = norm(name);
    if (!key || /^(top pick|alternatives?|good to know|day \d+|sources?|what it costs|party|dates?)$/.test(key)) continue;
    const hit = known.find(h => h.key === key || h.key.includes(key) || key.includes(h.key));
    if (hit) claims.push({ claim: `Hotel: ${name}`, status: 'supported', note: 'listed in the search evidence' });
    else if (/\b(hotel|inn|resort|hostel|lodge|villa|suites?|apartments?|homestay|house|residences?|pension)\b/i.test(name)) {
      hotelsKnown = false; claims.push({ claim: `Hotel: ${name}`, status: 'unsupported', note: 'not in the search evidence' });
      hints.push(`Remove or replace "${name}": it was not returned by the hotel search.`);
    }
  }
  const nightly = known.flatMap(h => [h.nightly, h.total / constraints.nights].filter((n): n is number => typeof n === 'number' && n > 0));
  const allowed = new Set<number>();
  const add = (n: number) => { allowed.add(Math.round(n * 100) / 100); allowed.add(Math.round(n)); };
  for (const h of known) { add(h.total); if (h.nightly) { add(h.nightly); add(h.nightly * constraints.nights); } add(h.total / constraints.nights); }
  for (const f of evidence.flights ?? []) if (f.total) add(f.total);
  if (constraints.budget_per_night) { add(constraints.budget_per_night); add(constraints.budget_per_night * constraints.nights); }
  // Totals for the party (e.g. flights x travellers, sum of hotel + flights) are derived, so allow sums of two evidence totals.
  const totals = known.map(h => h.total).concat((evidence.flights ?? []).flatMap(f => f.total ? [f.total] : []));
  for (const a of totals) for (const b of totals) add(a + b);
  // Figures the knowledge desk states itself (daily costs, ranges) are evidence too.
  for (const text of evidence.knowledge ?? []) for (const n of moneyFigures(text, constraints.currency ?? 'USD')) add(n);
  for (const text of evidence.knowledge ?? []) for (const m of text.matchAll(/[-–]\s?(?:US)?\$?\s?(\d[\d,]*(?:\.\d+)?)/g)) { const n = Number(m[1]!.replace(/,/g, '')); if (Number.isFinite(n) && n > 0) add(n); }
  let pricesMatch = true;
  for (const figure of new Set(moneyFigures(plan_text, constraints.currency ?? 'USD'))) {
    const ok = [...allowed].some(a => Math.abs(a - figure) <= Math.max(1, a * 0.005));
    // Rough activity costs ("~$30") are estimates the plan labels itself; only flag figures above a small threshold that look like hotel or flight prices.
    const looksLikeStayPrice = figure >= 60 && (nightly.length === 0 || figure >= Math.min(...nightly) * 0.5);
    if (ok) claims.push({ claim: `Price: ${figure}`, status: 'supported' });
    else if (looksLikeStayPrice && figure >= 100) { pricesMatch = false; claims.push({ claim: `Price: ${figure} ${constraints.currency ?? 'USD'}`, status: 'unsupported', note: 'not a total or nightly price from the evidence' }); hints.push(`Replace the price ${figure} with a figure from the search evidence, or label it as a rough estimate.`); }
    else claims.push({ claim: `Price: ${figure}`, status: 'unverifiable', note: 'looks like a rough activity estimate' });
  }
  let budgetOk = true;
  if (constraints.budget_per_night) {
    for (const name of mentioned) {
      const hit = known.find(h => norm(name) && (h.key === norm(name) || h.key.includes(norm(name))));
      if (!hit) continue;
      const n = hit.nightly ?? hit.total / constraints.nights;
      // The top pick must respect the cap. Alternatives over the cap must say so.
      if (n > constraints.budget_per_night * 1.001 && !new RegExp(`${hit.name.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]{0,160}(over|above|exceeds|more than)[^\\n]{0,60}(budget|cap)`, 'i').test(plan_text)) {
        budgetOk = false; claims.push({ claim: `Budget: ${hit.name} costs ${n.toFixed(0)}/night`, status: 'unsupported', note: `over the ${constraints.budget_per_night}/night cap and not flagged` });
        hints.push(`Drop "${hit.name}" or state that it is over the ${constraints.budget_per_night} per night budget.`);
      }
    }
  }
  const occupancy = occupancyStated(plan_text, constraints);
  if (!occupancy) { claims.push({ claim: 'Party', status: 'unsupported', note: 'children travel but the plan does not state them' }); hints.push(`State that the party is ${constraints.adults} adult(s) and ${constraints.children_ages!.length} child(ren), ages ${constraints.children_ages!.join(', ')}.`); }
  return { claims, hints, checks: { hotels_known: hotelsKnown, prices_match: pricesMatch, budget_ok: budgetOk, occupancy_stated: occupancy } };
}

const placesSchema = z.object({ places: z.array(z.object({ place: z.string().max(120), grounded: z.boolean(), note: z.string().max(200).optional() })).max(20) });
const PLACES_SYSTEM = `You audit a travel plan for another agent. List every named attraction, landmark, museum, beach, park or activity venue in the plan (not hotels). For each, set grounded=true only if it appears in the knowledge text provided or is a famous, well-established landmark of that destination you are certain exists under that exact name. Set grounded=false for anything invented, misnamed or doubtful. Reply with JSON only: {"places":[{"place":"...","grounded":true|false,"note":"..."}]}`;

async function placesPass(config: Config, request: AuditRequest, model?: LanguageModel) {
  if (!model && !config.OPENROUTER_API_KEY) return undefined;
  try {
    const result = await generateText({ model: model ?? modelFor(config), system: PLACES_SYSTEM, maxRetries: 0, abortSignal: AbortSignal.timeout(40000),
      prompt: `Knowledge text:\n${(request.evidence.knowledge ?? []).join('\n---\n').slice(0, 6000) || '(none)'}\n\nPlan:\n${request.plan_text.slice(0, 8000)}` });
    const text = result.text.trim().replace(/^```(?:json)?|```$/g, '').trim();
    return placesSchema.parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))).places;
  } catch { return undefined; }
}

export async function auditPlan(config: Config, input: unknown, model?: LanguageModel): Promise<AuditResult> {
  const parsed = auditRequestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'INVALID_AUDIT_REQUEST', 'audit_request_json does not match the audit schema.');
  const request = parsed.data;
  const rules = auditRules(request);
  const claims = [...rules.claims], hints = [...rules.hints];
  const places = await placesPass(config, request, model);
  let placesGrounded = true;
  if (places) {
    for (const p of places) {
      if (p.grounded) claims.push({ claim: `Place: ${p.place}`, status: 'supported', ...(p.note ? { note: p.note } : {}) });
      else { placesGrounded = false; claims.push({ claim: `Place: ${p.place}`, status: 'unsupported', note: p.note ?? 'not grounded in the knowledge evidence' }); hints.push(`Remove "${p.place}" or replace it with a landmark from the knowledge desk answer.`); }
    }
  }
  const checks = { ...rules.checks, places_grounded: placesGrounded };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  // Unsupported claims are listed first so a cap on the list never hides them.
  const order = { unsupported: 0, unverifiable: 1, supported: 2 } as const;
  const bounded = claims.sort((a, b) => order[a.status] - order[b.status]).slice(0, MAX_CLAIMS);
  return {
    verdict: failed.length ? 'revise' : 'pass',
    summary: failed.length ? `Revise: ${failed.join(', ')} failed.` : `Pass: ${claims.filter(c => c.status === 'supported').length} claims supported by the evidence.`,
    checks, claims: bounded, rewrite_hints: hints.slice(0, 10), audited_at: new Date().toISOString(), method: places ? 'rules+model' : 'rules',
  };
}
