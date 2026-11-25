import { formatLines, translateTitledMany, type ProgramText, type TitledOutcome } from './epg-translation';
import { englishName } from './subtitle-translation';

export const VOD_TRANSLATION_FEATURE = 'vod-translation';
const PROMPT_VERSION = 1;

function systemPrompt(target: string): string {
  const language = englishName(target);
  return [
    `You translate movie and TV series information into ${language}, as a streaming service in that language writes it.`,
    ...formatLines(language),
    `Use a title's established ${language} release title when it has one; otherwise keep the title as it is.`,
    'Keep names of people and places as they are usually written.',
  ].join('\n');
}

/** Movies', series', or episodes' titles and descriptions in `target`; the original stands for text already in it. */
export function translateVods(items: readonly ProgramText[], target: string, signal?: AbortSignal): Promise<TitledOutcome[]> {
  return translateTitledMany({ feature: VOD_TRANSLATION_FEATURE, system: systemPrompt(target), promptVersion: PROMPT_VERSION }, items, signal);
}
