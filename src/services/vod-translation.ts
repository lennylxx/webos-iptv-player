import { translateTitled, type ProgramText } from './epg-translation';
import { englishName } from './subtitle-translation';

export const VOD_TRANSLATION_FEATURE = 'vod-translation';
const PROMPT_VERSION = 1;

function systemPrompt(target: string): string {
  const language = englishName(target);
  return [
    `You translate movie and TV series information into ${language}.`,
    'The user message gives a movie, series, or episode title and its description.',
    `Return the title and the description in natural ${language}, as a streaming service in that language writes them.`,
    `Use a title's established ${language} release title when it has one; otherwise keep the title as it is.`,
    'Keep names of people and places as they are usually written.',
    `Copy text already in ${language} unchanged. Return an empty title or description when there is none.`,
    'Translate only: add no facts, comments, or explanations, and do not shorten.',
  ].join('\n');
}

/** A movie's, series', or episode's title and description in `target`; the original stands for text already in it. */
export function translateVod(item: ProgramText, target: string, signal?: AbortSignal): Promise<ProgramText> {
  return translateTitled({ feature: VOD_TRANSLATION_FEATURE, system: systemPrompt(target), promptVersion: PROMPT_VERSION }, item, signal);
}
