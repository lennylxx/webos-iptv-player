const SYNONYM_GROUPS = [
  ['sports', 'sport', 'footy', 'football', 'soccer', 'athletics'],
  ['kids', 'kid', 'children', 'child', 'cartoons', 'cartoon', 'animation', 'animated'],
  ['news', 'headlines', 'current affairs'],
  ['movies', 'movie', 'films', 'film', 'cinema'],
  ['music', 'songs', 'song', 'concerts', 'concert'],
  ['documentaries', 'documentary', 'docs', 'history', 'nature'],
] as const;

const STOP_WORDS = new Set(['find', 'me', 'show', 'watch', 'for', 'please', 'channel', 'channels', 'program', 'programs']);

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function splitFolded(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function tokens(value: string): string[] {
  return splitFolded(fold(value));
}

function queryTokens(query: string): string[] {
  const all = tokens(query);
  const meaningful = all.filter(token => !STOP_WORDS.has(token));
  return meaningful.length ? meaningful : all;
}

function variants(token: string): string[] {
  for (const group of SYNONYM_GROUPS) {
    if ((group as readonly string[]).includes(token)) return [token, ...group.filter(value => value !== token)];
  }
  return [token];
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let edits = 0;
    for (let i = 0; i < a.length;) {
      if (a[i] === b[i]) {
        i++;
        continue;
      }
      if (edits > 0) return false;
      edits++;
      if (i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i]) i += 2;
      else i++;
    }
    return true;
  }

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex++;
      longIndex++;
    } else {
      if (edits > 0) return false;
      edits++;
      longIndex++;
    }
  }
  return true;
}

function tokenScore(queryToken: string, fieldTokens: string[]): number | null {
  let best: number | null = null;
  const expanded = variants(queryToken);
  for (let variantIndex = 0; variantIndex < expanded.length; variantIndex++) {
    const variant = expanded[variantIndex];
    for (const fieldToken of fieldTokens) {
      let score: number | null = null;
      if (fieldToken === variant) score = variantIndex === 0 ? 0 : 4;
      else if (fieldToken.startsWith(variant)) score = variantIndex === 0 ? 1 : 5;
      else if (variantIndex === 0 && variant.length >= 4 && withinOneEdit(variant, fieldToken)) score = 2;
      if (score !== null && (best === null || score < best)) best = score;
    }
  }
  return best;
}

export interface PreparedSearchItem<T> {
  item: T;
  values: string[];
  fieldTokens: string[][];
}

export function prepareSearchItems<T>(items: T[], fields: (item: T) => string[]): PreparedSearchItem<T>[] {
  return items.map(item => {
    const values = fields(item).map(fold).filter(Boolean);
    return { item, values, fieldTokens: values.map(splitFolded) };
  });
}

export function rankPrepared<T>(items: PreparedSearchItem<T>[], query: string): T[] {
  const q = fold(query.trim());
  const terms = queryTokens(query);
  if (!q || !terms.length) return [];
  const scored: { item: T; score: number; idx: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const prepared = items[i];
    const values = prepared.values;
    let directScore: number | null = null;
    for (let fieldIndex = 0; fieldIndex < values.length; fieldIndex++) {
      const value = values[fieldIndex];
      const pos = value.indexOf(q);
      if (pos === -1) continue;
      const tier = value === q ? 0 : pos === 0 ? 1 : !/[\p{L}\p{N}]/u.test(value[pos - 1]) ? 2 : 3;
      const score = tier * 1000 + fieldIndex * 100 + pos * 10 + value.length;
      if (directScore === null || score < directScore) directScore = score;
    }
    if (directScore !== null) {
      scored.push({ item: prepared.item, score: directScore, idx: i });
      continue;
    }

    let fuzzyScore = 10000;
    let matched = true;
    for (const term of terms) {
      let best: number | null = null;
      for (let fieldIndex = 0; fieldIndex < prepared.fieldTokens.length; fieldIndex++) {
        const score = tokenScore(term, prepared.fieldTokens[fieldIndex]);
        if (score !== null) {
          const weighted = score + fieldIndex * 10;
          if (best === null || weighted < best) best = weighted;
        }
      }
      if (best === null) {
        matched = false;
        break;
      }
      fuzzyScore += best;
    }
    if (matched) scored.push({ item: prepared.item, score: fuzzyScore, idx: i });
  }
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.map(s => s.item);
}

export function rankByFields<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  return rankPrepared(prepareSearchItems(items, fields), query);
}

export function rankByName<T extends { name: string }>(items: T[], query: string): T[] {
  const q = fold(query.trim());
  if (!q) return [];
  const scored: { item: T; tier: number; pos: number; len: number; idx: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const name = fold(items[i].name);
    const pos = name.indexOf(q);
    if (pos === -1) continue;
    let tier: number;
    if (name === q) tier = 0;                                    // exact
    else if (pos === 0) tier = 1;                                // prefix
    else if (!/[\p{L}\p{N}]/u.test(name[pos - 1])) tier = 2;     // query starts a word
    else tier = 3;                                               // mid-word substring
    scored.push({ item: items[i], tier, pos, len: name.length, idx: i });
  }
  scored.sort((a, b) =>
    a.tier - b.tier ||   // better tier first
    a.pos - b.pos ||     // earlier match first
    a.len - b.len ||     // shorter (more specific) name first
    a.idx - b.idx);      // original order — explicit, Chrome 68 sort isn't stable
  return scored.map(result => result.item);
}

export function rankChannels<T extends { name: string; group: string }>(items: T[], query: string): T[] {
  return rankByFields(items, query, item => [item.name, item.group]);
}
