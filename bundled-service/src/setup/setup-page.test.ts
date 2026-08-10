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
  it('exchanges the manual pairing code before showing setup controls', async () => {
    const fetchMock = vi.fn((url: string, options?: { method?: string; body?: string }) => {
      if (url === '/pair' && options?.method === 'POST') {
        return Promise.resolve(response({ token: 'paired-token' }));
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
    dom.window.document.querySelector<HTMLFormElement>('#pair-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
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
});
