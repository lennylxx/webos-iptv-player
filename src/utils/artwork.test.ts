import { afterEach, describe, expect, it, vi } from 'vitest';
import { backdropUrl } from './artwork';

const WEBOS = (chrome: number) => `Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(chrome)}.0.0.0 Safari/537.36`;

describe('backdropUrl', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('asks TMDB for a 1280px backdrop on webOS 4 and 5', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WEBOS(68));
    expect(backdropUrl('https://image.tmdb.org/t/p/original/x.jpg')).toBe('https://image.tmdb.org/t/p/w1280/x.jpg');
  });

  it('asks TMDB for the original on newer webOS', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WEBOS(79));
    expect(backdropUrl('https://image.tmdb.org/t/p/w780/x.jpg')).toBe('https://image.tmdb.org/t/p/original/x.jpg');
  });

  it('leaves other hosts alone', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WEBOS(53));
    expect(backdropUrl('http://host/t/p/original/x.jpg')).toBe('http://host/t/p/original/x.jpg');
  });
});
