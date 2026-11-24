import { CONFIG } from '../config';
import { LlmService } from '../services/llm/llm-service';
import {
  cachedExpansion,
  expandSearchQuery,
  expansionQuery,
  SEARCH_EXPANSION_FEATURE,
} from '../services/search-expansion';

/**
 * Once typing pauses on a query, marks it settled (worth the slower
 * transliterated ranking) and asks the AI model for other ways to write it,
 * holding both for the query's next ranking. A newer query cancels it.
 */
export class SearchQueryExpansion {
  private key: string | null = null;
  private settled = false;
  private alternatives: string[] = [];
  private timer: number | null = null;
  private abort: AbortController | null = null;

  // onReady gets the normalized query whose ranking should run again;
  // settlingAdds says whether its settled ranking would try more.
  constructor(
    private readonly onReady: (key: string) => void,
    private readonly settlingAdds: (key: string) => boolean,
  ) {}

  plan(query: string): void {
    const key = expansionQuery(query);
    if (key === this.key) return;
    this.cancel();
    this.key = key;
    if (key === null) return;
    const ai = LlmService.isReady(SEARCH_EXPANSION_FEATURE);
    const cached = ai ? cachedExpansion(query) : undefined;
    if (cached) this.alternatives = cached;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.settled = true;
      if (cached?.length || this.settlingAdds(key)) this.onReady(key);
      if (!ai || cached) return;
      const abort = new AbortController();
      this.abort = abort;
      expandSearchQuery(query, abort.signal).then((alternatives) => {
        if (this.key !== key || abort.signal.aborted) return;
        this.abort = null;
        this.alternatives = alternatives;
        if (alternatives.length) this.onReady(key);
      }, () => {
        if (this.abort === abort) this.abort = null;
      });
    }, CONFIG.SEARCH.EXPANSION_DELAY_MS);
  }

  alternativesFor(query: string): string[] | undefined {
    if (!this.alternatives.length || expansionQuery(query) !== this.key) return undefined;
    return this.alternatives;
  }

  // Whether typing paused on the query, so transliterated spellings are ranked too.
  settledOn(query: string): boolean {
    return this.settled && expansionQuery(query) === this.key;
  }

  cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    this.key = null;
    this.settled = false;
    this.alternatives = [];
  }
}
