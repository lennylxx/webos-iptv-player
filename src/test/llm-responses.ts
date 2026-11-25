// Response shapes recorded from hosted and LAN chat-completions servers,
// with synthetic text, hosts, and ids. Each call returns a fresh Response.

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const PER_MINUTE_MESSAGE = 'You exceeded your current quota, please check your plan and billing details. ' +
  'For more information on this error, head to: http://docs.ai.test/limits.\n' +
  '* Quota exceeded for metric: m/generate_requests, limit: 15, model: m1\n' +
  'Description: Generate content requests per minute limit exceeded on Free Tier.\n' +
  'Please retry in 43.199091833s.';

const PER_DAY_MESSAGE = 'You exceeded your current quota, please check your plan and billing details.\n' +
  '* Quota exceeded for metric: m/generate_requests, limit: 1500, model: m1\n' +
  'Description: Generate content requests per day limit exceeded on Free Tier.\n' +
  'Please retry in 21.5s.';

function quotaDetails(quotaId: string, retryDelay: string): unknown[] {
  return [
    { '@type': 'type.ai.test/rpc.Help', links: [{ description: 'Learn more', url: 'http://docs.ai.test/limits' }] },
    {
      '@type': 'type.ai.test/rpc.QuotaFailure',
      violations: [{ quotaMetric: 'm/generate_requests', quotaId, quotaDimensions: { model: 'm1' }, quotaValue: '15' }],
    },
    { '@type': 'type.ai.test/rpc.RetryInfo', retryDelay },
  ];
}

export const recorded = {
  /** Hosted per-minute throttle: array-wrapped, quota and billing words, RetryInfo, no headers. */
  perMinute429: (): Response => json([{
    error: {
      code: 429,
      message: PER_MINUTE_MESSAGE,
      status: 'RESOURCE_EXHAUSTED',
      details: quotaDetails('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '24s'),
    },
  }], 429),

  /** The same server once the day's requests are spent. */
  perDay429: (): Response => json([{
    error: {
      code: 429,
      message: PER_DAY_MESSAGE,
      status: 'RESOURCE_EXHAUSTED',
      details: quotaDetails('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '21s'),
    },
  }], 429),

  insufficientQuota429: (): Response => json({
    error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' },
  }, 429),

  plain429: (headers: Record<string, string> = {}): Response =>
    json({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, 429, headers),

  /** A per-minute token limit reached, worded with its limit, use, and this request's size. */
  tokensPerMinute429: (): Response => json({
    error: {
      message: 'Rate limit reached for m1 in organization org-1 on tokens per min (TPM): Limit 200000, Used 199000, ' +
        'Requested 3200. Please try again in 660ms.',
      type: 'tokens',
      code: 'rate_limit_exceeded',
    },
  }, 429),

  tooManyTokens429: (): Response => json({ message: 'Too many tokens, please wait before trying again.' }, 429),

  contextExceeded429: (): Response => json({
    error: { message: "This model's maximum context length is 8192 tokens.", code: 'context_length_exceeded' },
  }, 429),

  balance402: (): Response => json({ error: { message: 'Insufficient Balance', type: 'unknown_error' } }, 402),

  /** A hosted server's answer to a reasoning_effort value it doesn't take: no field named. */
  genericInvalidArgument400: (): Response =>
    json([{ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }], 400),

  /** A LAN server whose chat template throws on a reasoning_effort value it doesn't know. */
  templateException500: (): Response => json({
    error: {
      code: 500,
      message: "\n------------\nWhile executing CallExpression at line 52, column 32 in source:\n...\n" +
        "Error: Jinja Exception: raise_exception('Unexpected reasoning effort ' ~ reasoning_effort)",
      type: 'server_error',
    },
  }, 500),

  unknownName400: (field: string): Response => json([{
    error: { code: 400, message: `Invalid JSON payload received. Unknown name "${field}": Cannot find field.`, status: 'INVALID_ARGUMENT' },
  }], 400),

  invalidKey400: (): Response =>
    json([{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }], 400),

  invalidKeyStringError400: (): Response =>
    json({ code: 'invalid-argument', error: 'Incorrect API key provided: sk-k1***. You can obtain an API key from the console.' }, 400),

  invalidKey401: (): Response => json({ detail: 'Invalid API Key' }, 401),

  authType400: (): Response => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 400),

  balance403: (): Response => json({ error: { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing (overdue).' } }, 403),

  permission403: (): Response => json({ error: { code: 'AccessDenied', message: 'You do not have permission to access model m1.' } }, 403),

  forbidden403: (): Response => json({ error: { message: 'Forbidden', code: 403 } }, 403),

  maxTokensUnsupported400: (): Response => json({
    error: {
      message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      type: 'invalid_request_error',
      param: 'max_tokens',
      code: 'unsupported_parameter',
    },
  }, 400),

  overloaded529: (): Response => json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529),

  /** A reply with extra message fields beside the content, which must be ignored. */
  reply: (content: unknown, extra: Record<string, unknown> = {}, finishReason = 'stop', headers: Record<string, string> = {}): Response =>
    json({
      choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }, 200, headers),

  /** A model list with ids prefixed "models/" and display names, no context fields. */
  prefixedModels: (): Response => json({
    object: 'list',
    data: [{ id: 'models/m1', object: 'model', owned_by: 'o1', display_name: 'Model One' }],
  }, 200),
};
