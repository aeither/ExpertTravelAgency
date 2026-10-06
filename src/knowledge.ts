import { generateText, type LanguageModel } from 'ai';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { modelFor } from './agent.js';

// General destination knowledge for other agents (the Travel Expert orchestrator calls this). No hotel prices, no bookings.
const SYSTEM = `You are the Expert Travel Agency's destination knowledge desk, answering another travel agent.
Give concise, practical facts about the destination: best time to visit, getting around, typical daily costs in USD as rough ranges, safety, local etiquette, and one or two well-known landmarks. Answer the question if one is given.
Use only well-established general knowledge. Never invent hotels, restaurants, prices of specific places or opening hours. If you are unsure, say so. At most 140 words, plain text, no markdown.`;

export async function destinationKnowledge(config: Config, input: { destination: string; question?: string }, model?: LanguageModel) {
  if (!model && !config.OPENROUTER_API_KEY) throw new ApiError(503, 'KNOWLEDGE_UNAVAILABLE', 'The knowledge desk has no model configured.');
  // The free router model is occasionally empty or rate limited, so try a few times before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await generateText({ model: model ?? modelFor(config), system: SYSTEM, prompt: `Destination: ${input.destination}\n${input.question ? `Question: ${input.question}` : 'Give the general overview.'}`, maxRetries: 0, abortSignal: AbortSignal.timeout(40000) });
      const answer = result.text.trim();
      if (answer) return { provider: 'expert-travel-agency', desk: 'destination-knowledge', destination: input.destination, answer, observed_at: new Date().toISOString() };
    } catch { /* try again */ }
  }
  throw new ApiError(502, 'KNOWLEDGE_FAILED', 'The knowledge desk could not answer right now.', undefined, true);
}
