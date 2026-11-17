export function isWebOS(): boolean {
  return typeof navigator !== 'undefined' && /webOS|Web0S/i.test(navigator.userAgent);
}

// webOS 4 is the only target on Chromium 53. Its media pipeline starts an
// adaptive stream on the first variant at or above the start bitrate, where
// later versions take the highest one at or below it.
export function isWebOS4(): boolean {
  if (!isWebOS()) return false;
  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return !!chrome && parseInt(chrome[1], 10) < 68;
}
