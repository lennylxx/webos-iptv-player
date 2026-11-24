import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchTextMock } = vi.hoisted(() => ({ fetchTextMock: vi.fn() }));
vi.mock('../utils/fetch-helper', () => ({ fetchText: fetchTextMock }));

import type { SidecarSubtitle } from '../types';
import { VodSubtitles } from './vod-subtitles';

class FakeVTTCue {
  line?: number;
  align?: string;

  constructor(
    public startTime: number,
    public endTime: number,
    public text: string,
  ) {}
}

function fakeTrack() {
  const cues: FakeVTTCue[] = [];
  return {
    kind: 'subtitles',
    mode: 'disabled' as TextTrackMode,
    cues,
    addCue: (cue: FakeVTTCue) => cues.push(cue),
    removeCue: (cue: FakeVTTCue) => {
      const index = cues.indexOf(cue);
      if (index >= 0) cues.splice(index, 1);
    },
  };
}

function sidecar(over: Partial<SidecarSubtitle> = {}): SidecarSubtitle {
  return {
    id: over.id ?? '1',
    name: over.name ?? 'Track 1',
    lang: over.lang ?? 'l1',
    url: over.url ?? 'http://host/a.srt',
    text: over.text,
  };
}

let subs: VodSubtitles;
let track: ReturnType<typeof fakeTrack>;
let addTextTrack: ReturnType<typeof vi.fn>;
let video: HTMLVideoElement;

beforeEach(() => {
  vi.stubGlobal('VTTCue', FakeVTTCue);
  fetchTextMock.mockReset();
  track = fakeTrack();
  addTextTrack = vi.fn(() => track);
  video = { addTextTrack } as unknown as HTMLVideoElement;
  subs = new VodSubtitles();
});

describe('VodSubtitles', () => {
  it('renders an SRT sidecar through addTextTrack', async () => {
    fetchTextMock.mockResolvedValue(
      '1\n00:00:01,000 --> 00:00:02,500\nHi\n',
    );
    subs.attach(video, [sidecar()]);

    await subs.show(0);

    expect(addTextTrack).toHaveBeenCalledWith('subtitles', 'Track 1', 'l1');
    expect(track.mode).toBe('showing');
    expect(track.cues).toEqual([
      { startTime: 1, endTime: 2.5, text: 'Hi' },
    ]);
    expect(subs.activeIndex).toBe(0);
    expect(subs.owns(track as unknown as TextTrack)).toBe(true);
  });

  it('uses in-memory text and preserves WebVTT cue settings', async () => {
    subs.attach(video, [sidecar({
      url: '',
      text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:80% align:center\nHi\n',
    })]);

    await subs.show(0);

    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(track.cues[0]).toMatchObject({
      startTime: 1,
      endTime: 2,
      text: 'Hi',
      line: 80,
      align: 'center',
    });
  });

  it('caches parsed cues and reuses one TextTrack across selections', async () => {
    fetchTextMock
      .mockResolvedValueOnce('1\n00:00:01,000 --> 00:00:02,000\nAlpha\n')
      .mockResolvedValueOnce('1\n00:00:03,000 --> 00:00:04,000\nBravo\n');
    subs.attach(video, [
      sidecar(),
      sidecar({ id: '2', name: 'Track 2', url: 'http://host/b.srt' }),
    ]);

    await subs.show(0);
    await subs.show(1);
    await subs.show(0);

    expect(fetchTextMock).toHaveBeenCalledTimes(2);
    expect(addTextTrack).toHaveBeenCalledOnce();
    expect(track.cues.map(cue => cue.text)).toEqual(['Alpha']);
  });

  it('ignores a repeated selection while the same sidecar is active', async () => {
    let resolveFetch: (value: string) => void = () => {};
    fetchTextMock.mockReturnValue(new Promise<string>((resolve) => {
      resolveFetch = resolve;
    }));
    subs.attach(video, [sidecar()]);
    const first = subs.show(0);
    const repeated = subs.show(0);
    resolveFetch('1\n00:00:01,000 --> 00:00:02,000\nHi\n');

    await Promise.all([first, repeated]);

    expect(fetchTextMock).toHaveBeenCalledOnce();
    expect(track.cues).toHaveLength(1);
  });

  it('renders only the latest selection when an earlier load finishes last', async () => {
    let resolveFirst: (value: string) => void = () => {};
    fetchTextMock.mockImplementation((url: string) => {
      if (url.endsWith('a.srt')) {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(
        '1\n00:00:03,000 --> 00:00:04,000\nBravo\n',
      );
    });
    subs.attach(video, [
      sidecar(),
      sidecar({ id: '2', name: 'Track 2', url: 'http://host/b.srt' }),
    ]);
    const first = subs.show(0);

    await subs.show(1);
    resolveFirst('1\n00:00:01,000 --> 00:00:02,000\nAlpha\n');
    await first;

    expect(subs.activeIndex).toBe(1);
    expect(track.cues.map(cue => cue.text)).toEqual(['Bravo']);
  });

  it('re-renders cached cues after hide without fetching again', async () => {
    fetchTextMock.mockResolvedValue(
      '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
    );
    subs.attach(video, [sidecar()]);

    await subs.show(0);
    subs.hide();
    await subs.show(0);

    expect(fetchTextMock).toHaveBeenCalledOnce();
    expect(addTextTrack).toHaveBeenCalledOnce();
    expect(track.mode).toBe('showing');
    expect(track.cues).toHaveLength(1);
  });

  it('hides the active renderer when asked to show an invalid index', async () => {
    subs.attach(video, [sidecar({
      url: '',
      text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
    })]);
    await subs.show(0);

    await subs.show(99);

    expect(subs.activeIndex).toBe(-1);
    expect(track.mode).toBe('disabled');
    expect(track.cues).toEqual([]);
  });

  it('drops a load that finishes after a new item is attached', async () => {
    let resolveFetch: (value: string) => void = () => {};
    fetchTextMock.mockReturnValue(new Promise<string>((resolve) => {
      resolveFetch = resolve;
    }));
    subs.attach(video, [sidecar()]);
    const pending = subs.show(0);

    subs.attach(video, [sidecar({ id: '2', name: 'Track 2' })]);
    resolveFetch('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
    await pending;

    expect(addTextTrack).not.toHaveBeenCalled();
    expect(subs.activeIndex).toBe(-1);
  });

  it('allows a failed load to be retried', async () => {
    fetchTextMock.mockRejectedValueOnce(new Error('net'));
    subs.attach(video, [sidecar()]);

    await subs.show(0);
    expect(subs.activeIndex).toBe(-1);

    fetchTextMock.mockResolvedValueOnce(
      '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
    );
    await subs.show(0);

    expect(fetchTextMock).toHaveBeenCalledTimes(2);
    expect(track.cues).toHaveLength(1);
  });

  it('appends an online subtitle and returns its picker index', async () => {
    subs.attach(video, [sidecar()]);
    const index = subs.addOnline(video, sidecar({
      id: '2',
      name: 'Track 2',
      url: '',
      text: 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nHi\n',
    }));

    await subs.show(index);

    expect(index).toBe(1);
    expect(track.cues[0]).toMatchObject({ startTime: 3, endTime: 4 });
  });

  it('applies an absolute offset to rendered and future cues', async () => {
    subs.attach(video, [sidecar({
      url: '',
      text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
    })]);
    subs.setOffset(2);
    await subs.show(0);
    expect(track.cues[0]).toMatchObject({ startTime: 3, endTime: 4 });

    subs.setOffset(0.5);
    expect(track.cues[0]).toMatchObject({ startTime: 1.5, endTime: 2.5 });
  });

  it('hides and clears the reusable renderer', async () => {
    subs.attach(video, [sidecar({
      url: '',
      text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
    })]);
    await subs.show(0);

    subs.hide();
    expect(subs.activeIndex).toBe(-1);
    expect(track.mode).toBe('disabled');
    expect(track.cues).toEqual([]);

    subs.clear();
    await subs.show(0);
    expect(addTextTrack).toHaveBeenCalledOnce();
  });

  it('shows a translation from copied cues and updates its text live', async () => {
    subs.attach(video, [sidecar({
      url: '',
      text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlpha\n\n00:00:03.000 --> 00:00:04.000\nBravo\n',
    })]);
    const index = subs.addTranslation(0, 'Track 1 · l2', 'l2');
    expect(subs.translationOf(0, 'l2')).toBe(index);
    expect(subs.sourceOf(index)).toBe(0);
    expect(subs.sourceOf(0)).toBe(-1);

    subs.setCueTexts(index, [0], ['Early']);
    await subs.show(index);
    expect(track.cues.map(cue => cue.text)).toEqual(['Alpha', 'Bravo']);

    subs.setCueTexts(index, [1], ['Charlie']);
    expect(track.cues.map(cue => cue.text)).toEqual(['Alpha', 'Charlie']);
    expect((await subs.cuesOf(0)).map(cue => cue.text)).toEqual(['Alpha', 'Bravo']);

    // A text set while another subtitle shows is kept for the next show.
    await subs.show(0);
    subs.setCueTexts(index, [0], ['Delta']);
    expect(track.cues.map(cue => cue.text)).toEqual(['Alpha', 'Bravo']);
    await subs.show(index);
    expect(track.cues.map(cue => cue.text)).toEqual(['Delta', 'Charlie']);
  });

  it('redraws the track once its cues change, so a paused video shows them', async () => {
    const log: string[] = [];
    let mode: TextTrackMode = 'disabled';
    Object.defineProperty(track, 'mode', {
      get: () => mode,
      set: (value: TextTrackMode) => { mode = value; log.push(value); },
    });
    const addCue = track.addCue;
    track.addCue = (cue: FakeVTTCue) => { log.push(`add ${cue.text}`); return addCue(cue); };
    subs.attach(video, [sidecar({
      url: '',
      text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlpha\n\n00:00:03.000 --> 00:00:04.000\nBravo\n',
    })]);
    const index = subs.addTranslation(0, 'Track 1 · l2', 'l2');
    await subs.show(0);
    log.length = 0;

    await subs.show(index);
    expect(log.slice(-4)).toEqual(['add Alpha', 'add Bravo', 'hidden', 'showing']);

    (video as { currentTime: number }).currentTime = 3.5;
    log.length = 0;
    subs.setCueTexts(index, [0], ['Charlie']);
    expect(log).toEqual([]);
    subs.setCueTexts(index, [1], ['Delta']);
    expect(log).toEqual(['hidden', 'showing']);
    expect(mode).toBe('showing');
  });
});
