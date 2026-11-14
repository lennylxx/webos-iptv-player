import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import {
  SeekPreview,
  buildProviders,
  expandSeekPreviewTemplate,
  flussonicPreviewTemplate,
  nimblePreviewTemplate,
  parseHlsImagePlaylist,
  parseThumbnailVtt,
  pickHlsImageStream,
  type ImageLoader,
  type SeekPreviewSource,
} from './seek-preview';

const UTC = 1_700_000_000;

describe('expandSeekPreviewTemplate', () => {
  it('fills the previewed moment into start, end, and their aliases', () => {
    expect(expandSeekPreviewTemplate('http://host/c1/{utc}-${end}.jpg', UTC, UTC + 99, ''))
      .toBe(`http://host/c1/${UTC}-${UTC}.jpg`);
    expect(expandSeekPreviewTemplate('http://host/c1/${START}/{utcend}', UTC, 0, ''))
      .toBe(`http://host/c1/${UTC}/${UTC}`);
  });

  it('applies per-variable and whole-URL shifts', () => {
    expect(expandSeekPreviewTemplate('http://host/{utc:-5m}/{utc:+30}', UTC, 0, ''))
      .toBe(`http://host/${UTC - 300}/${UTC + 30}`);
    expect(expandSeekPreviewTemplate('http://host/{{shift:start:-1h}}{utc}', UTC, 0, ''))
      .toBe(`http://host/${UTC - 3600}`);
  });

  it('fills ISO times, the current time, and the stream token', () => {
    expect(expandSeekPreviewTemplate(
      'http://host/a?t={start_iso}&now=${timestamp}&k=${token}', UTC, UTC + 60, 't 1',
    )).toBe(`http://host/a?t=2023-11-14T22:13:20Z&now=${UTC + 60}&k=t%201`);
  });

  it('refuses a template with a variable it cannot fill', () => {
    expect(expandSeekPreviewTemplate('http://host/{utc}.jpg?u=${login}', UTC, 0, '')).toBeNull();
    expect(expandSeekPreviewTemplate('http://host/{utc}.jpg?k={key}', UTC, 0, '')).toBeNull();
  });
});

describe('provider URL derivation', () => {
  it('derives Flussonic preview URLs beside a recognized playback name', () => {
    expect(flussonicPreviewTemplate('http://host/g1/c1/archive-1700000000-3600.m3u8?token=t1', ''))
      .toBe('http://host/g1/c1/{utc}-preview.jpg?token=t1');
    expect(flussonicPreviewTemplate('http://host/c1/timeshift_abs-1700000000.ts', ''))
      .toBe('http://host/c1/{utc}-preview.jpg');
    expect(flussonicPreviewTemplate('http://host/c1/index.m3u8', 'flussonic'))
      .toBe('http://host/c1/{utc}-preview.jpg');
    expect(flussonicPreviewTemplate('http://host/c1/mpegts', 'fs'))
      .toBe('http://host/c1/{utc}-preview.jpg');
  });

  it('leaves generic and stream-less URLs alone', () => {
    expect(flussonicPreviewTemplate('http://host/c1/index.m3u8', '')).toBe('');
    expect(flussonicPreviewTemplate('http://host/c1/index.m3u8', 'default')).toBe('');
    expect(flussonicPreviewTemplate('http://host/index-1700000000-60.m3u8', '')).toBe('');
    expect(flussonicPreviewTemplate('http://host/c1/a.ts', 'flussonic')).toBe('');
  });

  it('derives Nimble DVR thumbnails beside a DVR playlist', () => {
    expect(nimblePreviewTemplate('http://host/app/c1/playlist_dvr_range-1700000000-600.m3u8?wmsAuthSign=s1'))
      .toBe('http://host/app/c1/dvr_thumbnail_{utc}.jpg?wmsAuthSign=s1');
    expect(nimblePreviewTemplate('http://host/app/c1/playlist_fmp4_dvr_timeshift-3600-120.m3u8'))
      .toBe('http://host/app/c1/dvr_thumbnail_{utc}.jpg');
    expect(nimblePreviewTemplate('http://host/app/c1/playlist.m3u8')).toBe('');
  });
});

describe('thumbnail tracks', () => {
  it('picks the HLS image stream closest to the preview width', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000',
      'video.m3u8',
      '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1,RESOLUTION=160x90,CODECS="jpeg",URI="small/i.m3u8"',
      '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=2,RESOLUTION=320x180,CODECS="jpeg",URI="big/i.m3u8"',
    ].join('\n');
    expect(pickHlsImageStream(master, 'http://host/v1/master.m3u8', 320))
      .toBe('http://host/v1/big/i.m3u8');
    expect(pickHlsImageStream('#EXTM3U\nvideo.m3u8', 'http://host/v1/master.m3u8', 320)).toBe('');
  });

  it('times HLS image-playlist sheets, skipping gaps', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-IMAGES-ONLY',
      '#EXTINF:60,',
      '#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=5x2,DURATION=6',
      'sheet-0.jpg',
      '#EXTINF:30,',
      '#EXT-X-GAP',
      'sheet-1.jpg',
      '#EXTINF:10,',
      'single.jpg',
      '#EXT-X-ENDLIST',
    ].join('\n');
    expect(parseHlsImagePlaylist(playlist, 'http://host/v1/i/index.m3u8')).toEqual([
      {
        start: 0, duration: 60, url: 'http://host/v1/i/sheet-0.jpg',
        tiles: { w: 160, h: 90, cols: 5, rows: 2, each: 6 },
      },
      { start: 90, duration: 10, url: 'http://host/v1/i/single.jpg', tiles: null },
    ]);
  });

  it('reads WebVTT thumbnail cues relative to the VTT', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00.000 --> 00:06.000',
      'img/sheet.jpg#xywh=0,0,160,90',
      '',
      '1',
      '01:00:06.000 --> 01:00:12.000',
      'http://host/other.png',
    ].join('\n');
    expect(parseThumbnailVtt(vtt, 'http://host/p/v.vtt')).toEqual([
      { start: 0, end: 6, url: 'http://host/p/img/sheet.jpg', tile: { x: 0, y: 0, w: 160, h: 90 } },
      { start: 3606, end: 3612, url: 'http://host/other.png', tile: null },
    ]);
  });
});

describe('SeekPreview', () => {
  let loads: string[];
  let outcomes: Record<string, boolean>;
  let onUpdate: ReturnType<typeof vi.fn>;
  let preview: SeekPreview;
  let info: ReturnType<typeof vi.spyOn>;

  const loader: ImageLoader = url => {
    loads.push(url);
    return outcomes[url] === false
      ? Promise.reject(new Error('image'))
      : Promise.resolve({ width: 320, height: 180 });
  };
  const source = (overrides: Partial<SeekPreviewSource> = {}): SeekPreviewSource => ({
    streamUrl: 'http://host/app/c1/playlist_dvr_range-1700000000-600.m3u8',
    mime: '',
    template: '',
    catchupType: '',
    utcAt: t => UTC + t,
    live: false,
    ...overrides,
  });
  const settle = async () => {
    vi.advanceTimersByTime(CONFIG.PLAYER.SEEK_PREVIEW_DEBOUNCE);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const lines = () => info.mock.calls.map(call => call.join(' ')).filter(line => line.includes('event=seek.preview'));
  const events = () => lines().filter(line => !line.includes('event=seek.preview.sources'));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    loads = [];
    outcomes = {};
    onUpdate = vi.fn();
    preview = new SeekPreview(onUpdate, loader);
    info = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    info.mockRestore();
  });

  it('shows a loaded frame and keeps it while the next one loads', async () => {
    preview.start(source({ template: 'http://host/p/{utc}.jpg' }));
    expect(preview.thumbnailAt(25)).toBeNull();
    await settle();
    expect(loads).toEqual([`http://host/p/${UTC + 20}.jpg`]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(preview.thumbnailAt(25)).toEqual({
      url: `http://host/p/${UTC + 20}.jpg`, tile: null, width: 320, height: 180,
    });
    // 28 shares the 10-second bucket: no new request.
    expect(preview.thumbnailAt(28)?.url).toBe(`http://host/p/${UTC + 20}.jpg`);
    expect(preview.thumbnailAt(45)?.url).toBe(`http://host/p/${UTC + 20}.jpg`);
    await settle();
    expect(preview.thumbnailAt(45)?.url).toBe(`http://host/p/${UTC + 40}.jpg`);
    expect(events()).toEqual(['[SeekPreview] Seek preview source event=seek.preview.source source=template']);
  });

  it('falls back to the next provider when the first serves no image', async () => {
    outcomes[`http://host/p/${UTC}.jpg`] = false;
    preview.start(source({ template: 'http://host/p/{utc}.jpg' }));
    preview.thumbnailAt(0);
    await settle();
    expect(loads).toEqual([
      `http://host/p/${UTC}.jpg`,
      `http://host/app/c1/dvr_thumbnail_${UTC}.jpg`,
    ]);
    expect(preview.thumbnailAt(0)?.url).toBe(`http://host/app/c1/dvr_thumbnail_${UTC}.jpg`);
    expect(events()).toEqual([
      '[SeekPreview] Seek preview source failed event=seek.preview.failed source=template reason=image',
      '[SeekPreview] Seek preview source event=seek.preview.source source=nimble',
    ]);
  });

  it('keeps a working provider through an isolated missing frame', async () => {
    outcomes[`http://host/p/${UTC + 10}.jpg`] = false;
    preview.start(source({ template: 'http://host/p/{utc}.jpg' }));
    preview.thumbnailAt(0);
    await settle();
    preview.thumbnailAt(10);
    await settle();
    expect(preview.thumbnailAt(10)).toBeNull();
    preview.thumbnailAt(20);
    await settle();
    expect(preview.thumbnailAt(20)?.url).toBe(`http://host/p/${UTC + 20}.jpg`);
  });

  it('waits for the target to settle before loading its frame', async () => {
    preview.start(source({ template: 'http://host/p/{utc}.jpg' }));
    preview.thumbnailAt(0);
    vi.advanceTimersByTime(CONFIG.PLAYER.SEEK_PREVIEW_DEBOUNCE - 50);
    preview.thumbnailAt(10);
    vi.advanceTimersByTime(CONFIG.PLAYER.SEEK_PREVIEW_DEBOUNCE - 50);
    expect(loads).toEqual([]);
    await settle();
    expect(loads).toEqual([`http://host/p/${UTC + 10}.jpg`]);
  });

  it('loads one frame at a time and ignores a failure the user moved past', async () => {
    let fail: () => void = () => {};
    preview = new SeekPreview(onUpdate, url => {
      loads.push(url);
      if (loads.length === 1) return new Promise((_, reject) => { fail = () => reject(new Error('image')); });
      return Promise.resolve({ width: 320, height: 180 });
    });
    preview.start(source({ template: 'http://host/p/{utc}.jpg' }));
    preview.thumbnailAt(0);
    await settle();
    preview.thumbnailAt(10);
    await settle();
    preview.thumbnailAt(20);
    await settle();
    expect(loads).toEqual([`http://host/p/${UTC}.jpg`]);
    fail();
    await settle();
    expect(loads).toEqual([`http://host/p/${UTC}.jpg`, `http://host/p/${UTC + 20}.jpg`]);
    expect(preview.thumbnailAt(20)?.url).toBe(`http://host/p/${UTC + 20}.jpg`);
    expect(events()).toEqual(['[SeekPreview] Seek preview source event=seek.preview.source source=template']);
  });

  it('skips a template it cannot fill and tries the next source', async () => {
    preview.start(source({ template: 'http://host/p/{utc}.jpg?u=${login}' }));
    preview.thumbnailAt(0);
    await settle();
    expect(loads).toEqual([`http://host/app/c1/dvr_thumbnail_${UTC}.jpg`]);
    expect(events()).toEqual([
      '[SeekPreview] Seek preview source unusable event=seek.preview.failed source=template reason=template',
      '[SeekPreview] Seek preview source event=seek.preview.source source=nimble',
    ]);
  });

  it('keeps a source whose frame near now is not ready yet', async () => {
    vi.setSystemTime((UTC + 30) * 1000);
    outcomes[`http://host/p/${UTC + 20}.jpg`] = false;
    preview.start(source({ template: 'http://host/p/{utc}.jpg' }));
    preview.thumbnailAt(20);
    await settle();
    expect(preview.thumbnailAt(20)).toBeNull();
    preview.thumbnailAt(0);
    await settle();
    expect(loads).toEqual([`http://host/p/${UTC + 20}.jpg`, `http://host/p/${UTC}.jpg`]);
    expect(preview.thumbnailAt(0)?.url).toBe(`http://host/p/${UTC}.jpg`);
    expect(events()).toEqual(['[SeekPreview] Seek preview source event=seek.preview.source source=template']);
  });

  it('crops HLS image-playlist tiles for a VOD', async () => {
    const master = '#EXTM3U\n#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1,RESOLUTION=160x90,URI="i.m3u8"\n';
    const images = '#EXTM3U\n#EXTINF:60,\n#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=5x2,DURATION=6\ns0.jpg\n';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.endsWith('master.m3u8') ? master : images,
    )));
    preview.start(source({ streamUrl: 'http://host/v1/master.m3u8', utcAt: null }));
    preview.thumbnailAt(40);
    await settle();
    await vi.waitFor(() => expect(preview.thumbnailAt(40)).not.toBeNull());
    expect(preview.thumbnailAt(40)).toEqual({
      url: 'http://host/v1/s0.jpg',
      tile: { x: 160, y: 90, w: 160, h: 90 },
      width: 800,
      height: 180,
    });
  });

  it('offers nothing for a direct VOD file', async () => {
    preview.start(source({ streamUrl: 'http://host/movie/1.mkv', utcAt: null }));
    expect(preview.thumbnailAt(10)).toBeNull();
    await settle();
    expect(loads).toEqual([]);
    expect(lines()).toEqual(['[SeekPreview] Seek preview sources event=seek.preview.sources sources=none live=false']);
  });

  it('logs the sources it will try and when every one has failed', async () => {
    outcomes[`http://host/p/${UTC}.jpg`] = false;
    outcomes[`http://host/app/c1/dvr_thumbnail_${UTC}.jpg`] = false;
    preview.start(source({ template: 'http://host/p/{utc}.jpg' }));
    preview.thumbnailAt(0);
    await settle();
    await settle();
    expect(lines()).toEqual([
      '[SeekPreview] Seek preview sources event=seek.preview.sources sources=template,nimble,hls live=false',
      '[SeekPreview] Seek preview source failed event=seek.preview.failed source=template reason=image',
      '[SeekPreview] Seek preview source failed event=seek.preview.failed source=nimble reason=image',
      '[SeekPreview] Seek preview unavailable event=seek.preview.exhausted tried=template,nimble,hls',
    ]);
  });
});

describe('buildProviders', () => {
  it('skips WebVTT thumbnails on a live DVR window but keeps time-based sources', () => {
    const base: SeekPreviewSource = {
      streamUrl: 'http://host/app/c1/playlist_dvr.m3u8',
      mime: '',
      template: 'http://host/thumbs.vtt',
      catchupType: '',
      utcAt: t => UTC + t,
      live: false,
    };
    expect(buildProviders(base).map(p => p.name)).toEqual(['vtt', 'nimble', 'hls']);
    expect(buildProviders({ ...base, live: true }).map(p => p.name)).toEqual(['nimble']);
  });
});
