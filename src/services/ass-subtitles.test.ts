// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// assjs is loaded lazily via a dynamic import inside `show`; stub the whole
// module so the real DOM renderer never runs and each instance is observable.
const { fetchTextMock, assInstances, FakeASS } = vi.hoisted(() => {
  const assInstances: Array<{ content: string; video: unknown; container: HTMLElement; destroyed: boolean; delay: number; started: number }> = [];
  class FakeASS {
    private i: number;
    constructor(public content: string, public video: HTMLVideoElement, public opt: { container: HTMLElement }) {
      const i = assInstances.push({ content, video, container: opt.container, destroyed: false, delay: 0, started: 0 }) - 1;
      this.i = i;
      // Like assjs, frames start on a play event.
      video.addEventListener('playing', () => { assInstances[i].started++; });
    }
    set delay(v: number) { assInstances[this.i].delay = v; }
    get delay() { return assInstances[this.i].delay; }
    destroy() { assInstances[this.i].destroyed = true; return this; }
    show() { return this; }
    hide() { return this; }
  }
  return { fetchTextMock: vi.fn(), assInstances, FakeASS };
});
vi.mock('assjs', () => ({ default: FakeASS }));
vi.mock('../utils/fetch-helper', () => ({ fetchText: fetchTextMock }));

import { AssSubtitles, isAssSidecar } from './ass-subtitles';
import type { SidecarSubtitle } from '../types';

const sidecar = (over: Partial<SidecarSubtitle> = {}): SidecarSubtitle =>
  ({ id: '1', name: 'Track 1', lang: 'l1', url: 'http://host/a.ass', ...over });

describe('isAssSidecar', () => {
  it('is true for .ass and .ssa', () => {
    expect(isAssSidecar('http://host/a.ass')).toBe(true);
    expect(isAssSidecar('http://host/a.ssa')).toBe(true);
  });

  it('is false for .srt, .vtt and a URL with no extension', () => {
    expect(isAssSidecar('http://host/a.srt')).toBe(false);
    expect(isAssSidecar('http://host/a.vtt')).toBe(false);
    expect(isAssSidecar('http://host/a')).toBe(false);
  });

  it('tolerates query strings, hashes and mixed case', () => {
    expect(isAssSidecar('http://host/a.ASS?token=1')).toBe(true);
    expect(isAssSidecar('http://host/a.Ssa#frag')).toBe(true);
    expect(isAssSidecar('http://host/a.srt?x=.ass')).toBe(false);
  });
});

describe('AssSubtitles', () => {
  let subs: AssSubtitles;
  let container: HTMLElement;
  let video: HTMLVideoElement;

  beforeEach(() => {
    assInstances.length = 0;
    fetchTextMock.mockReset();
    subs = new AssSubtitles();
    container = document.createElement('div');
    document.body.appendChild(container);
    video = document.createElement('video');
  });
  afterEach(() => { container.remove(); });

  it('fetches the ASS body and renders it into an #ass-overlay inside the container', async () => {
    fetchTextMock.mockResolvedValue('[Script Info]\n');
    subs.attach(video, container, [sidecar()]);
    await subs.show(0);
    const overlay = container.querySelector('#ass-overlay');
    expect(overlay).not.toBeNull();
    expect(assInstances).toHaveLength(1);
    expect(assInstances[0].content).toBe('[Script Info]\n');
    expect(assInstances[0].container).toBe(overlay);
    expect(assInstances[0].video).toBe(video);
  });

  it('destroys a prior instance before showing another (one track at a time)', async () => {
    fetchTextMock.mockResolvedValue('body');
    subs.attach(video, container, [sidecar(), sidecar({ name: 'Track 2', url: 'http://host/b.ass' })]);
    await subs.show(0);
    await subs.show(1);
    expect(assInstances).toHaveLength(2);
    expect(assInstances[0].destroyed).toBe(true);
    expect(assInstances[1].destroyed).toBe(false);
  });

  it('drops a show whose generation changed mid-fetch', async () => {
    subs.attach(video, container, [sidecar()]);
    fetchTextMock.mockImplementation(async () => {
      (subs as unknown as { gen: number }).gen = 99; // a newer selection/stop landed
      return 'body';
    });
    await subs.show(0);
    expect(assInstances).toHaveLength(0);
    expect(container.querySelector('#ass-overlay')).toBeNull();
  });

  it('swallows a fetch failure and shows nothing', async () => {
    subs.attach(video, container, [sidecar()]);
    fetchTextMock.mockRejectedValue(new Error('net'));
    await subs.show(0);
    expect(assInstances).toHaveLength(0);
    expect(container.querySelector('#ass-overlay')).toBeNull();
  });

  it('is a no-op when the index is out of range', async () => {
    subs.attach(video, container, [sidecar()]);
    await subs.show(5);
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(assInstances).toHaveLength(0);
  });

  it('hide destroys the active instance but leaves the overlay in place for reuse', async () => {
    fetchTextMock.mockResolvedValue('body');
    subs.attach(video, container, [sidecar()]);
    await subs.show(0);
    subs.hide();
    expect(assInstances[0].destroyed).toBe(true);
    expect(container.querySelector('#ass-overlay')).not.toBeNull();
  });

  it('destroy tears down the instance and removes the overlay', async () => {
    fetchTextMock.mockResolvedValue('body');
    subs.attach(video, container, [sidecar()]);
    await subs.show(0);
    subs.destroy();
    expect(assInstances[0].destroyed).toBe(true);
    expect(container.querySelector('#ass-overlay')).toBeNull();
  });

  it('renders preloaded ASS text without fetching', async () => {
    subs.attach(video, container, [{ id: 'a1', name: 'Alpha', lang: 'l1', url: '', text: '[Script Info]\n' }]);
    await subs.show(0);
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(container.querySelector('#ass-overlay')).toBeTruthy();
  });

  it('applies the offset as an assjs delay on show and updates a live instance', async () => {
    fetchTextMock.mockResolvedValue('body');
    subs.attach(video, container, [sidecar()]);
    subs.setOffset(3);
    await subs.show(0);
    expect(assInstances[0].delay).toBe(3);
    subs.setOffset(-1.5);
    expect(assInstances[0].delay).toBe(-1.5);
  });

  it('fetches a sidecar once and redraws it with new text while shown', async () => {
    fetchTextMock.mockResolvedValue('body');
    subs.attach(video, container, [sidecar(), sidecar({ id: '2' })]);
    expect(await subs.contentOf(0)).toBe('body');
    subs.setOffset(2);
    await subs.show(0);
    expect(fetchTextMock).toHaveBeenCalledTimes(1);

    subs.setText(1, 'hidden');
    expect(assInstances).toHaveLength(1);
    subs.setText(0, 'translated');
    expect(assInstances).toHaveLength(2);
    expect(assInstances[0].destroyed).toBe(true);
    expect(assInstances[1]).toMatchObject({ content: 'translated', delay: 2, destroyed: false });
    expect(await subs.contentOf(0)).toBe('translated');
  });

  it('starts drawing frames for an instance made while the video plays', async () => {
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    subs.attach(video, container, [{ id: 'a1', name: 'Alpha', lang: 'l1', url: '', text: 'body' }]);
    await subs.show(0);
    subs.setText(0, 'again');
    expect(assInstances.map(instance => instance.started)).toEqual([1, 1]);
    expect(Object.prototype.hasOwnProperty.call(video, 'addEventListener')).toBe(false);
  });
});
