// @vitest-environment node

import { readFileSync } from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const PAGE_HTML = readFileSync(
  new URL('./setup-page.html', import.meta.url),
  'utf8',
);

function response(data: unknown, status = 200): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe('setup page forms', () => {
  it('connects automatically after the fourth pairing digit', async () => {
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/pair' && options?.method === 'POST') {
        return Promise.resolve(response({ token: 'paired-token' }));
      }
      if (url === '/setup-state?token=paired-token') {
        return Promise.resolve(response({ playlists: [], xtreamAccounts: [], epgUrl: '' }));
      }
      if (url === '/uploads') return Promise.resolve(response([]));
      return Promise.resolve(response({ error: 'unexpected request' }, 500));
    });
    const dom = new JSDOM(PAGE_HTML, {
      runScripts: 'dangerously',
      url: 'http://host/',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'languages', { value: ['en'] });
        window.fetch = fetchMock as unknown as typeof window.fetch;
        window.HTMLFormElement.prototype.reportValidity = () => true;
      },
    });

    const code = dom.window.document.querySelector<HTMLInputElement>('#pair-code')!;
    code.value = '1234';
    code.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const request = fetchMock.mock.calls.find(call => call[0] === '/pair');
    expect(JSON.parse(String(request![1]?.body))).toEqual({ code: '1234' });
    expect(dom.window.document.querySelector<HTMLElement>('#pair-card')!.hidden).toBe(true);
    expect(dom.window.document.querySelector<HTMLElement>('#setup-card')!.hidden).toBe(false);
    dom.window.close();
  });

  it('submits a playlist with the QR token and waits for TV acknowledgement', async () => {
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({ playlists: [], xtreamAccounts: [], epgUrl: '' }));
      }
      if (url === '/setup-actions?token=abc123' && options?.method === 'POST') {
        return Promise.resolve(response({ id: 7, type: 'playlist' }, 201));
      }
      if (url === '/setup-actions/7?token=abc123') {
        return Promise.resolve(response({ id: 7, pending: false }));
      }
      return Promise.resolve(response({ error: 'unexpected request' }, 500));
    });
    const errors: Error[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error));
    const dom = new JSDOM(PAGE_HTML, {
      runScripts: 'dangerously',
      url: 'http://host/setup?token=abc123',
      virtualConsole,
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'languages', { value: ['en'] });
        window.fetch = fetchMock as unknown as typeof window.fetch;
        window.HTMLFormElement.prototype.reportValidity = () => true;
      },
    });

    const form = dom.window.document.querySelector<HTMLFormElement>(
      '.config-fields[data-action="playlist"]',
    )!;
    form.querySelector<HTMLInputElement>('[name="name"]')!.value = 'Alpha';
    form.querySelector<HTMLInputElement>('[name="url"]')!.value = 'http://host/a.m3u';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const post = fetchMock.mock.calls.find(call => call[0] === '/setup-actions?token=abc123');
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      type: 'playlist',
      name: 'Alpha',
      url: 'http://host/a.m3u',
    });
    expect(form.querySelector('.config-status')!.textContent).toBe('Saved on TV');
    expect(form.querySelector<HTMLInputElement>('[name="url"]')!.value).toBe('');
    expect(errors).toEqual([]);
    dom.window.close();
  });

  it('renders synchronized sources and removes an Xtream account by id', async () => {
    let removed = false;
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({
          playlists: [{ id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' }],
          xtreamAccounts: removed
            ? []
            : [{ id: 'x1', name: 'host', serverUrl: 'http://host', username: 'u1' }],
          epgUrl: 'http://host/epg.xml',
        }));
      }
      if (url === '/setup-actions?token=abc123' && options?.method === 'POST') {
        return Promise.resolve(response({ id: 9, type: 'remove-source' }, 201));
      }
      if (url === '/setup-actions/9?token=abc123') {
        removed = true;
        return Promise.resolve(response({ id: 9, pending: false }));
      }
      return Promise.resolve(response({ error: 'unexpected request' }, 500));
    });
    const dom = new JSDOM(PAGE_HTML, {
      runScripts: 'dangerously',
      url: 'http://host/setup?token=abc123',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'languages', { value: ['en'] });
        window.fetch = fetchMock as unknown as typeof window.fetch;
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(dom.window.document.querySelectorAll('.configured-item')).toHaveLength(3);
    expect(dom.window.document.querySelector('#configured-list')!.textContent)
      .not.toContain('password');
    const buttons = dom.window.document.querySelectorAll<HTMLButtonElement>('.configured-remove');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    await new Promise(resolve => setTimeout(resolve, 0));

    const post = fetchMock.mock.calls.find(call =>
      call[0] === '/setup-actions?token=abc123' && call[1]?.method === 'POST');
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      type: 'remove-source',
      sourceId: 'x1',
    });
    expect(dom.window.document.querySelector('#configured-list')!.textContent)
      .not.toContain('host · u1');
    dom.window.close();
  });

  it('masks saved subtitle credentials and clears one on a single delete', async () => {
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({
          playlists: [],
          xtreamAccounts: [],
          epgUrl: '',
          onlineSubtitles: {
            preferredLanguage: '',
            subdlConfigured: true,
            assrtConfigured: false,
            opensubtitlesConfigured: true,
            opensubtitlesApiKeyConfigured: true,
            opensubtitlesPasswordConfigured: true,
            opensubtitlesUsername: 'u1',
          },
        }));
      }
      if (url === '/setup-actions?token=abc123' && options?.method === 'POST') {
        return Promise.resolve(response({ id: 12, type: 'online-subtitles' }, 201));
      }
      if (url === '/setup-actions/12?token=abc123') {
        return Promise.resolve(response({ id: 12, pending: false }));
      }
      return Promise.resolve(response({ error: 'unexpected request' }, 500));
    });
    const dom = new JSDOM(PAGE_HTML, {
      runScripts: 'dangerously',
      url: 'http://host/setup?token=abc123',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'languages', { value: ['en'] });
        window.fetch = fetchMock as unknown as typeof window.fetch;
        window.HTMLFormElement.prototype.reportValidity = () => true;
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const form = dom.window.document.querySelector<HTMLFormElement>(
      '.config-fields[data-action="online-subtitles"]',
    )!;
    const subdl = form.querySelector<HTMLInputElement>('[name="subdlApiKey"]')!;
    expect(subdl.value).toBe('********');
    expect(form.querySelector<HTMLInputElement>('[name="opensubtitlesUsername"]')!.value)
      .toBe('u1');
    subdl.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    }));
    expect(subdl.value).toBe('');
    const password = form.querySelector<HTMLInputElement>(
      '[name="opensubtitlesPassword"]',
    )!;
    password.value = 'p1';
    password.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const post = fetchMock.mock.calls.find(call =>
      call[0] === '/setup-actions?token=abc123' && call[1]?.method === 'POST');
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      type: 'online-subtitles',
      preferredLanguage: '',
      subdlApiKey: '',
      opensubtitles: { password: 'p1' },
    });
    expect(dom.window.document.querySelector('#subtitle-state')!.textContent)
      .toBe('SubDL: Configured · Assrt: Built-in access · OpenSubtitles: Configured');
    expect(password.value).toBe('********');
    dom.window.close();
  });
});
