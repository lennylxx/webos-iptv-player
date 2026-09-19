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
  it('switches language from the globe menu and saves it in a cookie', () => {
    const dom = new JSDOM(PAGE_HTML, {
      runScripts: 'dangerously',
      url: 'http://host:1234/',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'languages', { value: ['en'] });
      },
    });

    const trigger = dom.window.document.querySelector<HTMLButtonElement>('#language-trigger')!;
    trigger.click();
    const option = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-locale="zh-CN"]',
    )!;
    option.click();

    expect(dom.window.document.documentElement.lang).toBe('zh-CN');
    expect(dom.window.document.querySelector('.pair-title')!.textContent).toBe('连接电视');
    expect(dom.window.document.querySelector('#language-current')!.textContent).toBe('ZH');
    expect(dom.window.document.querySelector('[data-message="programGuideSources"]')!.textContent)
      .toBe('手动 XMLTV 源');
    expect(dom.window.document.cookie).toContain('iptv_setup_locale=zh-CN');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    dom.window.close();
  });

  it('connects automatically after the fourth pairing digit', async () => {
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/pair' && options?.method === 'POST') {
        return Promise.resolve(response({ token: 'paired-token' }));
      }
      if (url === '/setup-state?token=paired-token') {
        return Promise.resolve(response({
          playlists: [],
          xtreamAccounts: [],
          manualEpgSources: [],
        }));
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
    expect(Array.from(dom.window.document.querySelectorAll('.pair-slot'))
      .map(slot => slot.textContent)).toEqual(['1', '2', '3', '4']);
    await new Promise(resolve => setTimeout(resolve, 0));

    const request = fetchMock.mock.calls.find(call => call[0] === '/pair');
    expect(JSON.parse(String(request![1]?.body))).toEqual({ code: '1234' });
    expect(dom.window.document.querySelector<HTMLElement>('#pair-card')!.hidden).toBe(true);
    expect(dom.window.document.querySelector<HTMLElement>('#setup-card')!.hidden).toBe(false);
    expect(dom.window.document.querySelector('[data-message="programGuideSources"]')!.textContent)
      .toBe('Manual XMLTV sources');
    expect(dom.window.document.querySelector('.epg-source-empty')?.textContent)
      .toBe('No EPG sources added yet');
    dom.window.close();
  });

  it('submits a playlist with the QR token and waits for TV acknowledgement', async () => {
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({
          playlists: [],
          xtreamAccounts: [],
          manualEpgSources: [],
        }));
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
          manualEpgSources: [{
            url: 'http://host/epg.xml',
            playlistIds: ['p1'],
          }],
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

    expect(dom.window.document.querySelectorAll('.configured-item')).toHaveLength(2);
    expect(dom.window.document.querySelectorAll('.epg-source-row')).toHaveLength(1);
    expect(Array.from(dom.window.document.querySelectorAll('.epg-scope-option.selected'))
      .map(option => option.textContent)).toEqual(['Alpha']);
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

  it('submits ordered EPG sources with playlist scopes', async () => {
    const posts: unknown[] = [];
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({
          playlists: [
            { id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' },
            { id: 'p2', name: 'Bravo', url: 'http://host/b.m3u' },
          ],
          xtreamAccounts: [],
          manualEpgSources: [
            { url: 'http://host/a.xml', playlistIds: ['p1'] },
            { url: 'http://host/b.xml', playlistIds: [] },
          ],
        }));
      }
      if (url === '/setup-actions?token=abc123' && options?.method === 'POST') {
        posts.push(JSON.parse(String(options.body)));
        return Promise.resolve(response({ id: 30, type: 'manual-epg-sources' }, 201));
      }
      if (url === '/setup-actions/30?token=abc123') {
        return Promise.resolve(response({ id: 30, pending: false }));
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

    const rows = dom.window.document.querySelectorAll<HTMLElement>('.epg-source-row');
    rows[0].querySelector<HTMLButtonElement>('.epg-source-control.down')!.click();
    const reordered = dom.window.document.querySelectorAll<HTMLElement>('.epg-source-row');
    expect(reordered[0].querySelector<HTMLInputElement>('.epg-url-input')!.value)
      .toBe('http://host/b.xml');
    const alpha = Array.from(reordered[0].querySelectorAll<HTMLButtonElement>(
      '.epg-scope-option',
    )).find(option => option.textContent === 'Alpha')!;
    alpha.click();

    dom.window.document.querySelector<HTMLFormElement>('#epg-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(posts).toEqual([{
      type: 'manual-epg-sources',
      sources: [
        { url: 'http://host/b.xml', playlistIds: ['p1'] },
        { url: 'http://host/a.xml', playlistIds: ['p1'] },
      ],
    }]);
    dom.window.close();
  });

  it('rejects duplicate EPG URLs before submitting', async () => {
    const posts: unknown[] = [];
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({
          playlists: [{ id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' }],
          xtreamAccounts: [],
          manualEpgSources: [
            { url: 'http://host/a.xml', playlistIds: ['p1'] },
            { url: 'http://host/b.xml', playlistIds: [] },
          ],
        }));
      }
      if (url === '/setup-actions?token=abc123' && options?.method === 'POST') {
        posts.push(JSON.parse(String(options.body)));
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

    const inputs = dom.window.document.querySelectorAll<HTMLInputElement>('.epg-url-input');
    inputs[1].value = inputs[0].value;
    inputs[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    dom.window.document.querySelector<HTMLFormElement>('#epg-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(posts).toEqual([]);
    expect(dom.window.document.querySelector('#epg-form .config-status')?.textContent)
      .toBe('Each EPG source must use a unique URL.');
    expect(dom.window.document.activeElement).toBe(inputs[1]);
    dom.window.close();
  });

  it('does not overwrite unsaved EPG scope changes during state refresh', async () => {
    let stateRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        stateRequests += 1;
        return Promise.resolve(response({
          playlists: [{ id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' }],
          xtreamAccounts: [],
          manualEpgSources: [{
            url: 'http://host/epg.xml',
            playlistIds: ['p1'],
          }],
        }));
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

    const alpha = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(
      '.epg-scope-option',
    )).find(option => option.textContent === 'Alpha')!;
    alpha.click();
    expect(Array.from(dom.window.document.querySelectorAll('.epg-scope-option.selected'))
      .map(option => option.textContent)).toEqual(['All playlists']);
    const input = dom.window.document.querySelector<HTMLInputElement>('.epg-url-input')!;
    input.focus();

    await dom.window.eval('refreshSetupState()');

    expect(stateRequests).toBeGreaterThanOrEqual(2);
    expect(dom.window.document.querySelector('.epg-url-input')).toBe(input);
    expect(dom.window.document.activeElement).toBe(input);
    expect(Array.from(dom.window.document.querySelectorAll('.epg-scope-option.selected'))
      .map(option => option.textContent)).toEqual(['All playlists']);
    dom.window.close();
  });

  it('reconciles dirty EPG scopes when playlists change', async () => {
    let stateRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        stateRequests += 1;
        return Promise.resolve(response({
          playlists: stateRequests === 1
            ? [
              { id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' },
              { id: 'p2', name: 'Bravo', url: 'http://host/b.m3u' },
            ]
            : [
              { id: 'p2', name: 'Bravo', url: 'http://host/b.m3u' },
              { id: 'p3', name: 'Charlie', url: 'http://host/c.m3u' },
            ],
          xtreamAccounts: [],
          manualEpgSources: [{
            url: 'http://host/epg.xml',
            playlistIds: ['p1'],
          }],
        }));
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

    const input = dom.window.document.querySelector<HTMLInputElement>('.epg-url-input')!;
    input.value = 'http://host/unsaved.xml';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    input.focus();

    await dom.window.eval('refreshSetupState()');

    expect(dom.window.document.querySelector('.epg-url-input')).toBe(input);
    expect(input.value).toBe('http://host/unsaved.xml');
    expect(dom.window.document.activeElement).toBe(input);
    expect(Array.from(dom.window.document.querySelectorAll('.epg-scope-option'))
      .map(option => option.textContent)).toEqual([
      'All playlists',
      'Bravo',
      'Charlie',
    ]);
    expect(Array.from(dom.window.document.querySelectorAll('.epg-scope-option.selected'))
      .map(option => option.textContent)).toEqual(['All playlists']);
    dom.window.close();
  });

  it('toggles URL, Xtream, and uploaded sources through setup actions', async () => {
    let nextId = 20;
    const posts: unknown[] = [];
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') {
        return Promise.resolve(response([
          { id: 'upload-1', name: 'Uploaded', count: 2, createdAt: 1 },
        ]));
      }
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({
          playlists: [{ id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' }],
          xtreamAccounts: [{
            id: 'x1',
            name: 'host',
            serverUrl: 'http://host',
            username: 'u1',
            enabled: false,
          }],
          uploadedPlaylists: [{
            id: 'u1',
            uploadId: 'upload-1',
            enabled: false,
          }],
          manualEpgSources: [],
        }));
      }
      if (url === '/setup-actions?token=abc123' && options?.method === 'POST') {
        posts.push(JSON.parse(String(options.body)));
        return Promise.resolve(response({
          id: nextId++,
          type: 'set-source-enabled',
        }, 201));
      }
      if (url.indexOf('/setup-actions/') === 0) {
        return Promise.resolve(response({ pending: false }));
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
    await new Promise(resolve => setTimeout(resolve, 0));

    const switches = dom.window.document.querySelectorAll<HTMLButtonElement>('.source-switch');
    expect(switches).toHaveLength(3);
    expect(Array.from(switches).map(button => button.getAttribute('aria-pressed')))
      .toEqual(['true', 'false', 'false']);
    switches.forEach(button => button.click());
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(posts).toEqual([
      { type: 'set-source-enabled', sourceId: 'p1', enabled: false },
      { type: 'set-source-enabled', sourceId: 'x1', enabled: true },
      { type: 'set-source-enabled', sourceId: 'u1', enabled: true },
    ]);
    dom.window.close();
  });

  it('masks saved subtitle credentials and clears one on a single delete', async () => {
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/uploads') return Promise.resolve(response([]));
      if (url === '/setup-state?token=abc123') {
        return Promise.resolve(response({
          playlists: [],
          xtreamAccounts: [],
          manualEpgSources: [],
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
