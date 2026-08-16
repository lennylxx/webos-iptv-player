// Deterministic avatar visuals for an Xtream account label. Pure and unit-tested
// so the switcher component just renders the result. Legacy-safe (no
// Unicode property escapes): letters outside ASCII are detected via case folding.

// A stable hue in [0,360) from the label, at fixed saturation/lightness so the
// circle stays readable while distinguishing accounts by color.
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 55%, 45%)`;
}

// The initial shown in the circle. Latin letters uppercase; cased non-Latin
// letters uppercase; uncased letter scripts (e.g. CJK) are kept as-is; empty or
// ASCII digit/punctuation falls back to '#'.
export function firstLetter(name: string): string {
  const c = name.trim().charAt(0);
  if (!c) return '#';
  if (/[a-z]/i.test(c)) return c.toUpperCase();
  if (c >= '\u0080') {
    return c.toLowerCase() !== c.toUpperCase() ? c.toUpperCase() : c;
  }
  return '#';
}
