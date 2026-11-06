type ConsoleLike = { [method: string]: unknown };

export interface ServiceLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// Mirrors the app's createLogger: every line starts with `[tag]`.
export function createLogger(tag: string, target: ConsoleLike = console as unknown as ConsoleLike): ServiceLogger {
  const prefix = '[' + tag + ']';
  const emit = (method: string) => (...args: unknown[]) => {
    (target[method] as (...a: unknown[]) => void).apply(target, ([prefix] as unknown[]).concat(args));
  };
  return { info: emit('log'), warn: emit('warn'), error: emit('error') };
}
