// Two independent 32-bit hashes (FNV-1a and a djb2 variant), so cache keys
// for long prompts collide far less than a single 32-bit hash would.
export function contentHash(parts: string[]): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  const text = parts.join('\u0000');
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    fnv ^= c;
    fnv = Math.imul(fnv, 0x01000193);
    djb = (Math.imul(djb, 33) ^ c) | 0;
  }
  return `${(fnv >>> 0).toString(36)}-${(djb >>> 0).toString(36)}-${text.length.toString(36)}`;
}
