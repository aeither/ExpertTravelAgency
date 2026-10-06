import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const flag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');
const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3026),
  TRAVEL_MODE: z.enum(['live', 'demo']).default('live'),
  API_KEY: z.string().default(''),
  DATA_PATH: z.string().default('.data/origin.sqlite'),
  DATABASE_URL_UNPOOLED: z.string().default(''),
  DATABASE_URL: z.string().default(''),
  CRON_SECRET: z.string().default(''),
  SOKOSUMI_COWORKER_ID: z.string().default(''),
  SOKOSUMI_COWORKER_API_KEY: z.string().default(''),
  // Paid Sokosumi tasks: quote, masumiPayment, escrow before work, result hash, completion, collection.
  SOKOSUMI_PAID: flag,
  // Poll Sokosumi from this process. Leave off on serverless hosts.
  SOKOSUMI_POLL: flag,
  PUBLIC_SEARCH: flag,
  // Flights (Duffel) are switched off for now: the agent plans activities and recommends hotels only.
  FLIGHTS_ENABLED: flag,
  DUFFEL_ACCESS_TOKEN: z.string().default(''),
  LITEAPI_API_KEY: z.string().default(''),
  LIVE_BOOKINGS_ALLOWED: flag,
  // Guest on hotel bookings made from a chat message, unless the message names one.
  GUEST_GIVEN_NAME: z.string().default('Alex'),
  GUEST_FAMILY_NAME: z.string().default('Traveller'),
  GUEST_EMAIL: z.email().default('alex.traveller@example.com'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(45000),
  // simulated: labelled rehearsal settlement with no chain. live: Masumi Payment Service.
  MASUMI_MODE: z.enum(['live', 'simulated']).default('live'),
  MASUMI_URL: z.url().default('http://127.0.0.1:3012/api/v1'),
  MASUMI_TOKEN: z.string().default(''),
  MASUMI_AGENT_IDENTIFIER: z.string().default(''),
  MASUMI_SUPPORTED_SOURCE_INDEX: z.coerce.number().int().min(0).max(24).default(0),
  MASUMI_PRICE_ATOMIC: z.string().regex(/^[1-9]\d{0,18}$/).default('1000000'),
  MASUMI_TOKEN_UNIT: z.string().regex(/^[a-f0-9]{56,150}$/).default('16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'),
});
export type Config = z.infer<typeof schema>;
export function getConfig(env: Record<string, string | undefined> = process.env): Config {
  const config = schema.parse(env);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.HOST) && config.API_KEY.length < 24) {
    throw new Error('Set API_KEY to at least 24 characters before using a public HOST.');
  }
  if (config.DUFFEL_ACCESS_TOKEN && !/^duffel_(test|live)_/.test(config.DUFFEL_ACCESS_TOKEN)) {
    throw new Error('DUFFEL_ACCESS_TOKEN must be a Duffel test or live token.');
  }
  return config;
}
