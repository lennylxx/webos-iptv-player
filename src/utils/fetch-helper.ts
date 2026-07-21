export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, timeout = 30000): Promise<string> {
  const response = await fetchWithTimeout(url, {}, timeout);
  return response.text();
}

export async function fetchMaybeGzipText(url: string, timeout = 30000): Promise<string> {
  const response = await fetchWithTimeout(url, {}, timeout);
  let bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const { gunzipSync } = await import('fflate');
    bytes = gunzipSync(bytes);
  }

  return new TextDecoder().decode(bytes);
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 2,
  timeout = 30000
): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url, options, timeout);
    } catch (err) {
      lastError = err as Error;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}
