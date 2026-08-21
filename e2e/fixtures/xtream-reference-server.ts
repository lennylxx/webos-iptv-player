import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type XtreamReferenceProfile =
  | 'player-api-only'
  | 'uncategorized-hls'
  | 'legacy-xc'
  | 'catchup-variants';

export interface XtreamRecordedRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
}

interface RequestWaiter {
  predicate: (request: XtreamRecordedRequest) => boolean;
  resolve: (request: XtreamRecordedRequest) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HLS = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch1"><display-name>Alpha</display-name></channel>
<programme channel="ch1" start="20240309100000 +0000" stop="20240309110000 +0000"><title>Earlier Show</title></programme>
<programme channel="ch1" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Live Show</title></programme>
</tv>`;

export class XtreamReferenceServer {
  origin = '';
  private server: Server | null = null;
  private readonly recorded: XtreamRecordedRequest[] = [];
  private readonly waiters: RequestWaiter[] = [];

  constructor(private readonly profile: XtreamReferenceProfile) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      const url = new URL(request.url || '/', this.origin || 'http://127.0.0.1');
      const recorded = {
        method: request.method || 'GET',
        pathname: url.pathname,
        searchParams: new URLSearchParams(url.searchParams),
      };
      this.recorded.push(recorded);
      this.resolveWaiters(recorded);

      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      this.respond(url, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject);
        const address = this.server!.address() as AddressInfo;
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Xtream reference server stopped'));
    }
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  actions(): string[] {
    return this.recorded
      .filter(request => request.pathname === '/player_api.php')
      .map(request => request.searchParams.get('action') || 'account_info');
  }

  timeshiftPaths(): string[] {
    const paths = this.recorded
      .map(request => request.pathname)
      .filter(path => path.indexOf('/timeshift/') === 0);
    return paths.filter((path, index) => paths.indexOf(path) === index);
  }

  waitForRequest(
    predicate: (request: XtreamRecordedRequest) => boolean,
    timeoutMs = 10000,
  ): Promise<XtreamRecordedRequest> {
    const existing = this.recorded.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: RequestWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Timed out waiting for Xtream request'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private resolveWaiters(request: XtreamRecordedRequest): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index];
      if (!waiter.predicate(request)) continue;
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(request);
    }
  }

  private respond(url: URL, response: import('node:http').ServerResponse): void {
    if (url.pathname === '/get.php') {
      if (this.profile === 'player-api-only') {
        this.text(response, 404, 'text/plain', 'Not found');
        return;
      }
      if (this.profile === 'uncategorized-hls') {
        this.text(response, 200, 'application/x-mpegurl', '#EXTM3U');
        return;
      }
      const extension = this.profile === 'legacy-xc' ? 'm3u8' : 'ts';
      const catchup = this.profile === 'legacy-xc' ? ' catchup="xc" catchup-days="7"' : '';
      const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="ch1" group-title="Group 1"${catchup},Alpha
${this.origin}/live/u1/p1/101.${extension}`;
      this.text(response, 200, 'application/x-mpegurl', playlist);
      return;
    }

    if (url.pathname === '/xmltv.php') {
      this.text(response, 200, 'application/xml', EPG);
      return;
    }

    if (url.pathname === '/player_api.php') {
      this.playerApi(url, response);
      return;
    }

    if (url.pathname.indexOf('/timeshift/') === 0) {
      if (this.profile === 'catchup-variants' && !url.pathname.endsWith('.m3u8')) {
        this.text(response, 404, 'text/plain', 'Not found');
        return;
      }
      this.stream(response, url.pathname.endsWith('.m3u8'));
      return;
    }

    if (url.pathname === '/streaming/timeshift.php' ||
        url.pathname.indexOf('/live/') === 0 ||
        url.pathname.indexOf('/direct/') === 0) {
      this.stream(response, url.pathname.endsWith('.m3u8'));
      return;
    }

    this.text(response, 404, 'text/plain', 'Not found');
  }

  private playerApi(url: URL, response: import('node:http').ServerResponse): void {
    const action = url.searchParams.get('action');
    if (!action) {
      this.json(response, {
        user_info: {
          auth: 1,
          status: 'Active',
          allowed_output_formats: ['ts', 'm3u8'],
        },
        server_info: {
          timezone: 'Etc/GMT-2',
          timestamp_now: 1709985600,
          time_now: '2024-03-09 14:00:00',
        },
      });
      return;
    }

    if (action === 'get_live_categories') {
      if (this.profile === 'uncategorized-hls') {
        this.text(response, 404, 'text/plain', 'Not found');
      } else {
        this.json(response, [{ category_id: '1', category_name: 'Group 1' }]);
      }
      return;
    }

    if (action === 'get_live_streams') {
      if (this.profile === 'player-api-only') {
        this.json(response, [
          {
            stream_id: 201,
            name: 'Alpha',
            stream_icon: '',
            epg_channel_id: 'ch1',
            category_id: '1',
            direct_source: `${this.origin}/direct/201.m3u8`,
            tv_archive: 0,
            tv_archive_duration: 0,
          },
          {
            stream_id: 202,
            name: 'Bravo',
            stream_icon: '',
            epg_channel_id: 'ch2',
            category_id: '9',
            direct_source: '',
            tv_archive: 0,
            tv_archive_duration: 0,
          },
        ]);
      } else if (this.profile === 'uncategorized-hls') {
        this.json(response, [{
          stream_id: 201,
          name: 'Alpha',
          category_id: '1',
          direct_source: '',
          tv_archive: 0,
          tv_archive_duration: 0,
        }]);
      } else {
        this.json(response, [{
          stream_id: 101,
          name: 'Alpha',
          category_id: '1',
          direct_source: '',
          tv_archive: 1,
          tv_archive_duration: 7,
        }]);
      }
      return;
    }

    if (action === 'get_simple_data_table') {
      if (this.profile === 'legacy-xc') {
        this.json(response, {});
      } else {
        this.json(response, this.archiveListings());
      }
      return;
    }

    if (action === 'get_simple_date_table') {
      this.json(response, this.archiveListings());
      return;
    }

    this.json(response, []);
  }

  private archiveListings(): object {
    return {
      epg_listings: [{
        start_timestamp: 1709978400,
        stop_timestamp: 1709982000,
        has_archive: 1,
      }],
    };
  }

  private stream(response: import('node:http').ServerResponse, hls: boolean): void {
    if (hls) {
      this.text(response, 200, 'application/vnd.apple.mpegurl', HLS);
    } else {
      this.text(response, 200, 'video/mp2t', '');
    }
  }

  private json(response: import('node:http').ServerResponse, body: unknown): void {
    this.text(response, 200, 'application/json', JSON.stringify(body));
  }

  private text(
    response: import('node:http').ServerResponse,
    status: number,
    contentType: string,
    body: string,
  ): void {
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(body);
  }
}
