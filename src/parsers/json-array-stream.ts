export class JsonArrayStreamError extends Error {
  /** The text stopped before the array closed, as a cut connection does. */
  constructor(message: string, readonly truncated = false) {
    super(message);
    this.name = 'JsonArrayStreamError';
  }
}

const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0xfeff;
}

// Splits a top-level JSON array into its elements as text arrives, so a
// response far larger than the parsed items it keeps never sits in memory
// whole. Each element is handed to JSON.parse on its own.
export class JsonArrayStream {
  private buffer = '';
  private pos = 0;
  private elementStart = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private state: 'before' | 'value' | 'done' = 'before';
  private expectValue = false;

  constructor(private readonly onElement: (value: unknown) => void) {}

  write(text: string): void {
    if (this.elementStart >= 0) {
      // Keep only the element still being read; the rest is parsed.
      this.buffer = this.buffer.slice(this.elementStart) + text;
      this.pos -= this.elementStart;
      this.elementStart = 0;
    } else {
      this.buffer = text;
      this.pos = 0;
    }
    this.scan();
  }

  finish(): void {
    if (this.state !== 'done') throw new JsonArrayStreamError('JSON array ended early', true);
  }

  private scan(): void {
    const text = this.buffer;
    const length = text.length;
    let i = this.pos;
    while (i < length) {
      const code = text.charCodeAt(i);
      if (this.state === 'value') {
        if (this.elementStart < 0 && !isSpace(code) && code !== COMMA && code !== CLOSE_BRACKET) {
          this.elementStart = i;
        }
        if (this.inString) {
          if (this.escaped) this.escaped = false;
          else if (code === BACKSLASH) this.escaped = true;
          else if (code === QUOTE) this.inString = false;
        } else if (code === QUOTE) {
          this.inString = true;
        } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
          this.depth++;
        } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
          if (this.depth === 0) {
            if (code === CLOSE_BRACE) throw new JsonArrayStreamError('Unexpected }');
            this.emit(text, i);
            this.state = 'done';
          } else {
            this.depth--;
          }
        } else if (code === COMMA && this.depth === 0) {
          this.emit(text, i);
          this.expectValue = true;
        }
      } else if (isSpace(code)) {
        // Whitespace between tokens.
      } else if (this.state === 'before') {
        if (code !== OPEN_BRACKET) throw new JsonArrayStreamError('Response is not a JSON array');
        this.state = 'value';
      } else {
        throw new JsonArrayStreamError('Unexpected data after JSON array');
      }
      i++;
    }
    this.pos = i;
  }

  private emit(text: string, end: number): void {
    const start = this.elementStart;
    this.elementStart = -1;
    const element = start < 0 ? '' : text.slice(start, end).trim();
    if (!element) {
      // `[]` is the only place a value may be missing.
      if (this.expectValue || text.charCodeAt(end) === COMMA) {
        throw new JsonArrayStreamError('Missing JSON array element');
      }
      return;
    }
    this.expectValue = false;
    let value: unknown;
    try {
      value = JSON.parse(element);
    } catch {
      throw new JsonArrayStreamError('Invalid JSON array element');
    }
    this.onElement(value);
  }
}
