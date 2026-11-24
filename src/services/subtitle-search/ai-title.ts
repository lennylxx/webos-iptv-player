import { LlmService } from '../llm/llm-service';
import type { NamedSchema } from '../llm/types';

export const SUBTITLE_TITLE_FEATURE = 'subtitle-title';
const PROMPT_VERSION = 1;

export interface AiSearchTitle {
  title: string;
  // 0 when the name gives none.
  year: number;
  season: number;
  episode: number;
  // The original or English title when the model knows it differs; '' otherwise.
  originalTitle: string;
}

interface Reply {
  title: string;
  year: number;
  season: number;
  episode: number;
  original_title: string;
}

const SCHEMA: NamedSchema = {
  name: 'subtitle_search_title',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      year: { type: 'integer', minimum: 0, maximum: 2100 },
      season: { type: 'integer', minimum: 0, maximum: 1000 },
      episode: { type: 'integer', minimum: 0, maximum: 10000 },
      original_title: { type: 'string' },
    },
    required: ['title', 'year', 'season', 'episode', 'original_title'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You clean up movie and TV series names from IPTV catalogs so a subtitle site can find them.',
  'The user message is JSON {"type":"movie"|"episode","name":"..."}.',
  'title: the title as the name writes it, in its language, without language or country tags, quality or release tags, or anything else that is not the title.',
  'year, season, episode: the numbers the name gives, else 0. Never guess them.',
  'original_title: the well-known original or English title when you are sure it differs from title, else "".',
].join('\n');

/** Asks the AI model for a clean search title; null when it gives nothing usable. */
export async function suggestSearchTitle(
  name: string,
  type: 'movie' | 'episode',
  signal?: AbortSignal,
): Promise<AiSearchTitle | null> {
  const outcome = await LlmService.run<Reply>({
    feature: SUBTITLE_TITLE_FEATURE,
    priority: 'foreground',
    system: SYSTEM_PROMPT,
    user: JSON.stringify({ type, name }),
    schema: SCHEMA,
    promptVersion: PROMPT_VERSION,
    maxTokens: 1024,
    signal,
  });
  const reply = outcome.value;
  const title = reply.title.trim();
  if (!title) return null;
  const original = reply.original_title.trim();
  return {
    title,
    year: reply.year,
    season: reply.season,
    episode: reply.episode,
    originalTitle: original.toLowerCase() === title.toLowerCase() ? '' : original,
  };
}
