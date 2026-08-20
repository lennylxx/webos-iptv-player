// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { DashSubtitles, cueMediaTime, pickWebVttSubtitle } from './dash-subtitles';

describe('DashSubtitles helpers', () => {
  it('maps segment-local cues onto the DASH media timeline', () => {
    const segment = { url: 'http://host/a.vtt', start: 20, duration: 4 };
    expect(cueMediaTime(segment, 1.5, 0)).toBe(21.5);
    expect(cueMediaTime(segment, 22, 0)).toBe(22);
  });

  it('keeps single-file WebVTT cue times unchanged', () => {
    const segment = { url: 'http://host/a.vtt', start: 0, duration: 0 };
    expect(cueMediaTime(segment, 12.5, 0)).toBe(12.5);
  });

  it('picks the requested WebVTT rendition and excludes native subtitles', () => {
    const subtitles = [
      {
        name: 'Track 1',
        lang: 'l1',
        isDefault: false,
        isForced: false,
        dash: { kind: 'native' as const },
      },
      {
        name: 'Track 2',
        lang: 'l2',
        isDefault: false,
        isForced: false,
        dash: { kind: 'webvtt' as const, url: 'http://host/a.vtt' },
      },
    ];
    expect(pickWebVttSubtitle(subtitles, { lang: 'l2' })?.name).toBe('Track 2');
    expect(pickWebVttSubtitle(subtitles, { lang: 'l1' })?.name).toBe('Track 2');
  });

  it('fetches a selected segment and adds its cues on the DASH timeline', async () => {
    vi.useFakeTimers();
    const manifest = `<?xml version="1.0"?><MPD
      xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
      <Period><AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate media="sub-$Time$.vtt" timescale="1">
          <SegmentTimeline><S t="20" d="4"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="s1"/>
      </AdaptationSet></Period></MPD>`;
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlpha\n';
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      url,
      text: async () => url.endsWith('.mpd') ? manifest : vtt,
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('VTTCue', class {
      startTime: number;
      endTime: number;
      text: string;
      constructor(start: number, end: number, text: string) {
        this.startTime = start;
        this.endTime = end;
        this.text = text;
      }
    });
    const cues: Array<{ startTime: number; endTime: number; text: string }> = [];
    const track = {
      mode: 'disabled',
      cues,
      addCue: (cue: { startTime: number; endTime: number; text: string }) => cues.push(cue),
      removeCue: (cue: { startTime: number }) => {
        const index = cues.indexOf(cue as typeof cues[number]);
        if (index >= 0) cues.splice(index, 1);
      },
    };
    const video = {
      currentTime: 20,
      seekable: { length: 1, start: () => 20, end: () => 24 },
      addTextTrack: () => track,
    } as unknown as HTMLVideoElement;
    const service = new DashSubtitles();

    await service.start(video, 'http://host/stream.mpd', { lang: 'l1' });

    expect(fetchMock).toHaveBeenCalledWith('http://host/sub-20.vtt');
    expect(cues).toEqual([{ startTime: 21, endTime: 22, text: 'Alpha' }]);
    expect(track.mode).toBe('showing');
    service.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('requests SegmentList mediaRange entries with a Range header', async () => {
    vi.useFakeTimers();
    const manifest = `<?xml version="1.0"?><MPD
      xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
      <Period><AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentList timescale="1" duration="4">
          <SegmentURL media="subs.vtt" mediaRange="100-199"/>
        </SegmentList>
        <Representation id="s1"/>
      </AdaptationSet></Period></MPD>`;
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      url,
      text: async () => url.endsWith('.mpd')
        ? manifest
        : 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAlpha\n',
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('VTTCue', class {
      constructor(
        public startTime: number,
        public endTime: number,
        public text: string,
      ) {}
    });
    const cues: TextTrackCue[] = [];
    const track = {
      mode: 'disabled',
      cues,
      addCue: (cue: TextTrackCue) => cues.push(cue),
      removeCue: (cue: TextTrackCue) => {
        const index = cues.indexOf(cue);
        if (index >= 0) cues.splice(index, 1);
      },
    };
    const video = {
      currentTime: 0,
      seekable: { length: 1, start: () => 0, end: () => 4 },
      addTextTrack: () => track,
    } as unknown as HTMLVideoElement;
    const service = new DashSubtitles();

    await service.start(video, 'http://host/stream.mpd', { lang: 'l1' });

    expect(fetchMock).toHaveBeenCalledWith('http://host/subs.vtt', {
      headers: { Range: 'bytes=100-199' },
    });
    service.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps dedupe keys bounded to the current manifest window', async () => {
    vi.useFakeTimers();
    let segmentTime = 20;
    const manifest = () => `<?xml version="1.0"?><MPD
      xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
      <Period><AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate media="sub-$Time$.vtt" timescale="1">
          <SegmentTimeline><S t="${String(segmentTime)}" d="4"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="s1"/>
      </AdaptationSet></Period></MPD>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      url,
      text: async () => url.endsWith('.mpd')
        ? manifest()
        : 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAlpha\n',
    })));
    vi.stubGlobal('VTTCue', class {
      constructor(
        public startTime: number,
        public endTime: number,
        public text: string,
      ) {}
    });
    const cues: TextTrackCue[] = [];
    const track = {
      mode: 'disabled',
      cues,
      addCue: (cue: TextTrackCue) => cues.push(cue),
      removeCue: (cue: TextTrackCue) => {
        const index = cues.indexOf(cue);
        if (index >= 0) cues.splice(index, 1);
      },
    };
    const video = {
      currentTime: 20,
      seekable: { length: 1, start: () => segmentTime, end: () => segmentTime + 4 },
      addTextTrack: () => track,
    } as unknown as HTMLVideoElement;
    const service = new DashSubtitles();

    await service.start(video, 'http://host/stream.mpd', { lang: 'l1' });
    segmentTime = 24;
    video.currentTime = 24;
    await (service as unknown as {
      refresh(url: string, want: { lang: string }, gen: number): Promise<void>;
      gen: number;
    }).refresh('http://host/stream.mpd', { lang: 'l1' },
      (service as unknown as { gen: number }).gen);

    expect(Array.from((service as unknown as { seen: Set<string> }).seen))
      .toEqual(['http://host/sub-24.vtt']);
    service.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
