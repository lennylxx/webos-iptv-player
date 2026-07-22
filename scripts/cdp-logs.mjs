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
  ];
}

export async function enableCdpLogs(client, { history = false } = {}) {
  await client.call('Runtime.enable');
  if (history) await client.call('Log.enable');
  await client.call('Console.enable');
}
