const redact = (value, enabled) => (enabled ? redactLogText(value) : String(value));

const renderArgument = (argument, redactSensitive) => {
  if (argument == null) return '';
  if ('value' in argument) {
    if (typeof argument.value !== 'object' || argument.value == null) {
      return redact(argument.value, redactSensitive);
    }
    return redact(JSON.stringify(argument.value) ?? String(argument.value), redactSensitive);
  }
  if (argument.unserializableValue != null) {
    return redact(argument.unserializableValue, redactSensitive);
  }
  if (argument.preview?.properties) {
    const body = argument.preview.properties
      .map((property) => `${property.name}: ${property.value}`)
      .join(', ');
    return redact(argument.subtype === 'array' ? `[${body}]` : `{${body}}`, redactSensitive);
  }
  return redact(argument.description ?? argument.type ?? '', redactSensitive);
};

const formatObservedAt = (timestamp, fallback) => {
  const timestampDate = typeof timestamp === 'number' ? new Date(timestamp) : null;
  if (timestampDate && Number.isFinite(timestampDate.getTime())) {
    return timestampDate.toISOString();
  }
  const fallbackDate = fallback instanceof Date ? fallback : new Date(fallback);
  return fallbackDate.toISOString();
};

export function redactLogText(value) {
  return String(value)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, '$1[redacted]')
    .replace(/(["']?(?:username|password|token|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[redacted]');
}

export function normalizeCdpLogEvent(
  method,
  params = {},
  observedAt = new Date(),
  { redactSensitive = false } = {},
) {
  if (method === 'Runtime.consoleAPICalled') {
    return {
      observedAt: formatObservedAt(params.timestamp, observedAt),
      source: 'console',
      level: params.type ?? 'log',
      text: (params.args ?? [])
        .map((argument) => renderArgument(argument, redactSensitive))
        .join(' '),
    };
  }

  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails ?? {};
    return {
      observedAt: formatObservedAt(params.timestamp, observedAt),
      source: 'exception',
      level: 'error',
      text: redact(
        details.exception?.description ?? details.text ?? '',
        redactSensitive,
      ),
    };
  }

  if (method === 'Log.entryAdded') {
    const entry = params.entry ?? {};
    return {
      observedAt: formatObservedAt(entry.timestamp, observedAt),
      source: entry.source ?? 'browser',
      level: entry.level ?? 'info',
      text: redact(entry.text ?? '', redactSensitive),
    };
  }

  if (method === 'Console.messageAdded') {
    const message = params.message ?? {};
    const parameters = message.parameters ?? [];
    const source = message.source === 'console-api' ? 'console'
      : message.source === 'javascript' && message.level === 'error' ? 'exception'
        : message.source ?? 'browser';
    return {
      // The legacy Console domain stamps seconds, not milliseconds.
      observedAt: formatObservedAt(
        typeof message.timestamp === 'number' ? message.timestamp * 1000 : undefined,
        observedAt,
      ),
      source,
      level: message.level ?? 'log',
      text: parameters.length > 0
        ? parameters.map((argument) => renderArgument(argument, redactSensitive)).join(' ')
        : redact(message.text ?? '', redactSensitive),
    };
  }

  throw new Error(`Unsupported CDP log event: ${method}`);
}

export function serializeCdpLogEvent(method, params, observedAt, options) {
  return `${JSON.stringify(normalizeCdpLogEvent(method, params, observedAt, options))}\n`;
}

export function subscribeCdpLogs(client, listener) {
  return [
    client.on('Runtime.consoleAPICalled', (params) =>
      listener('Runtime.consoleAPICalled', params)),
    client.on('Runtime.exceptionThrown', (params) =>
      listener('Runtime.exceptionThrown', params)),
    client.on('Log.entryAdded', (params) => listener('Log.entryAdded', params)),
    // A modern engine reports console calls on Runtime as well, so only an
    // engine without the Log domain gets them from Console.
    client.on('Console.messageAdded', (params) => {
      if (legacyConsoleClients.has(client)) listener('Console.messageAdded', params);
    }),
  ];
}

const legacyConsoleClients = new WeakSet();
const METHOD_NOT_FOUND = -32601;

// True once enableCdpLogs found an engine without the Log domain
// (Chromium 53 on webOS 4), which also ignores Runtime.evaluate awaitPromise.
export const isLegacyCdpEngine = (client) => legacyConsoleClients.has(client);

// Chromium 53 (webOS 4) has no Log domain and never sends
// Runtime.consoleAPICalled; its console output arrives only as
// Console.messageAdded, history included.
export async function enableCdpLogs(client, { history = false } = {}) {
  await client.call('Runtime.enable');
  try {
    await client.call(history ? 'Log.enable' : 'Log.disable');
  } catch (error) {
    if (error?.protocolCode !== METHOD_NOT_FOUND) throw error;
    legacyConsoleClients.add(client);
  }
  await client.call('Console.enable');
}
