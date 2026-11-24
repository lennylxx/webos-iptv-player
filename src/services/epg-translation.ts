import { LlmService } from './llm/llm-service';
import type { NamedSchema } from './llm/types';
import { englishName } from './subtitle-translation';

export const EPG_TRANSLATION_FEATURE = 'epg-translation';
const PROMPT_VERSION = 1;
// Keeps one request inside a small local model's context.
export const MAX_DESCRIPTION_CHARS = 1500;

export interface ProgramText {
  title: string;
  description: string;
}

const SCHEMA: NamedSchema = {
  name: 'program_translation',
  schema: {
    type: 'object',
    properties: { title: { type: 'string' }, description: { type: 'string' } },
    required: ['title', 'description'],
    additionalProperties: false,
  },
};

function systemPrompt(target: string): string {
  const language = englishName(target);
  return [
    `You translate TV guide program information into ${language}.`,
    'The user message gives a program title and its description.',
    `Return the title and the description in natural ${language}, as a TV guide in that language writes them.`,
    'Keep names of people, places, and teams as they are usually written. Keep a title that is a show\'s name when it has no common translation.',
    `Copy text already in ${language} unchanged. Return an empty description when there is none.`,
    'Translate only: add no facts, comments, or explanations, and do not shorten.',
  ].join('\n');
}

export function clipDescription(text: string): string {
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// The reply's text, or the original in full when the reply leaves it out or
// copies back what was sent, which may be clipped.
function replyOr(reply: string, sent: string, original: string): string {
  const text = reply.trim();
  return !sent || !text || normalized(text) === normalized(sent) ? original : text;
}

/** The program's title and description in `target`; the original stands for text already in it. */
export async function translateProgram(program: ProgramText, target: string, signal?: AbortSignal): Promise<ProgramText> {
  const title = program.title.trim();
  const description = clipDescription(program.description.trim());
  const outcome = await LlmService.run<ProgramText>({
    feature: EPG_TRANSLATION_FEATURE,
    priority: 'foreground',
    system: systemPrompt(target),
    user: `Title: ${title}\nDescription: ${description}`,
    schema: SCHEMA,
    promptVersion: PROMPT_VERSION,
    maxTokens: 2048,
    signal,
    // Once sent, a reply still lands in the cache when the focus has moved on.
    finishStarted: true,
  });
  return {
    title: replyOr(outcome.value.title, title, program.title),
    description: replyOr(outcome.value.description, description, program.description),
  };
}
