import { LlmService } from './llm/llm-service';
import type { NamedSchema } from './llm/types';

export const EPG_MATCH_FEATURE = 'epg-match';
const PROMPT_VERSION = 1;
export const EPG_MATCH_CANDIDATES = 30;
const MAX_PICKS = 3;

export interface GuideCandidate {
  id: string;
  channelId: string;
  name: string;
}

interface Reply {
  matches: Array<{ number: number; confidence: 'high' | 'medium' | 'low' }>;
}

const SCHEMA: NamedSchema = {
  name: 'epg_channel_match',
  schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        maxItems: MAX_PICKS,
        items: {
          type: 'object',
          properties: {
            number: { type: 'integer', minimum: 1, maximum: EPG_MATCH_CANDIDATES },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['number', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['matches'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You match an IPTV playlist channel to the same channel in a TV guide.',
  'The user message gives the playlist channel name, its group, and numbered guide channels as "n. name (id)".',
  'Return up to 3 guide channels that are the same channel, best first, by number, each with your confidence.',
  'The same channel means the same broadcaster and feed: a different region, language, or timeshift (+1) is a different channel.',
  'Ignore quality tags such as HD or 4K. Return no matches when none is the same channel.',
].join('\n');

/** Up to three guide channels the AI model takes for the same channel, best first. */
export async function suggestGuideMatches(
  channel: { name: string; group: string },
  candidates: readonly GuideCandidate[],
  signal?: AbortSignal,
): Promise<string[]> {
  const list = candidates.slice(0, EPG_MATCH_CANDIDATES);
  if (!list.length) return [];
  const user = [
    `Channel: ${channel.name}`,
    `Group: ${channel.group || '-'}`,
    'Guide channels:',
    ...list.map((candidate, i) => `${i + 1}. ${candidate.name} (${candidate.channelId})`),
  ].join('\n');
  const outcome = await LlmService.run<Reply>({
    feature: EPG_MATCH_FEATURE,
    priority: 'foreground',
    system: SYSTEM_PROMPT,
    user,
    schema: SCHEMA,
    promptVersion: PROMPT_VERSION,
    maxTokens: 1024,
    signal,
  });
  const picks: string[] = [];
  for (const match of outcome.value.matches) {
    const candidate = list[match.number - 1];
    if (!candidate || match.confidence === 'low' || picks.indexOf(candidate.id) >= 0) continue;
    picks.push(candidate.id);
  }
  return picks;
}
