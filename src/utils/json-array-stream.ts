export class JsonArrayStreamError extends Error {
  constructor(
    public readonly code: 'not_array' | 'invalid_json',
    message: string,
  ) {
    super(message);
    this.name = 'JsonArrayStreamError';
  }
}

const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const COMMA = 0x2c;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const BOM = 0xfeff;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

// Parses a top-level JSON array fed in text pieces and hands each element to
// onItem as soon as it closes, so a list of tens of megabytes never exists as
// one string or one parsed array.
export class JsonArrayStream {
  private state: 'start' | 'items' | 'done' | 'other' = 'start';
  private depth = 0;
  private inString = false;
  private escaped = false;
  private pending = '';
  private sawItem = false;

  constructor(private readonly onItem: (value: unknown) => void) {}

  push(text: string): void {
    let i = 0;
    if (this.state === 'other') {
      this.pending += text;
      return;
    }
    if (this.state === 'start') {
      while (i < text.length && (isSpace(text.charCodeAt(i)) || text.charCodeAt(i) === BOM)) i++;
      if (i === text.length) return;
      if (text.charCodeAt(i) !== OPEN_BRACKET) {
        // Kept whole so finish() can tell valid non-array JSON from garbage.
        this.state = 'other';
        this.pending = text.slice(i);
        return;
      }
      this.state = 'items';
      i++;
    }
    let start = i;
    for (; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (this.state === 'done') {
        if (!isSpace(code)) throw new JsonArrayStreamError('invalid_json', 'Unexpected text after the JSON array');
        continue;
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (code === BACKSLASH) this.escaped = true;
        else if (code === QUOTE) this.inString = false;
        continue;
      }
      if (code === QUOTE) this.inString = true;
      else if (code === OPEN_BRACE || code === OPEN_BRACKET) this.depth++;
      else if (code === CLOSE_BRACE || (code === CLOSE_BRACKET && this.depth > 0)) {
        if (--this.depth < 0) throw new JsonArrayStreamError('invalid_json', 'Unbalanced JSON array');
      } else if (this.depth === 0 && (code === COMMA || code === CLOSE_BRACKET)) {
        const element = this.pending + text.slice(start, i);
        this.pending = '';
        start = i + 1;
        this.emit(element, code === CLOSE_BRACKET);
        if (code === CLOSE_BRACKET) this.state = 'done';
      }
    }
    if (this.state === 'items') this.pending += text.slice(start);
  }

  finish(): void {
    if (this.state === 'other') {
      try {
        JSON.parse(this.pending);
      } catch {
        throw new JsonArrayStreamError('invalid_json', 'Response is not valid JSON');
      }
      throw new JsonArrayStreamError('not_array', 'Response is not a JSON array');
    }
    if (this.state !== 'done') throw new JsonArrayStreamError('invalid_json', 'JSON array ended early');
  }

  private emit(element: string, last: boolean): void {
    if (!/\S/.test(element)) {
      // `[]` closes with nothing in it; any other empty slot is malformed.
      if (last && !this.sawItem) return;
      throw new JsonArrayStreamError('invalid_json', 'Empty JSON array element');
    }
    this.sawItem = true;
    let value: unknown;
    try {
      value = JSON.parse(element);
    } catch {
      throw new JsonArrayStreamError('invalid_json', 'Invalid JSON array element');
    }
    this.onItem(value);
  }
}
