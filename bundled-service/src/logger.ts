type ConsoleLike = { [method: string]: unknown };

export interface ServiceLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

let emitting = false;

// Lets the service log tell this service's lines from webos-service chatter.
export function isLoggerEmitting(): boolean {
  return emitting;
}

// Mirrors the app's createLogger: every line starts with `[tag]`.
export function createLogger(tag: string, target: ConsoleLike = console as unknown as ConsoleLike): ServiceLogger {
  const prefix = '[' + tag + ']';
  const emit = (method: string) => (...args: unknown[]) => {
    emitting = true;
    try {
      (target[method] as (...a: unknown[]) => void).apply(target, ([prefix] as unknown[]).concat(args));
    } finally {
      emitting = false;
    }
  };
  return { info: emit('log'), warn: emit('warn'), error: emit('error') };
}
