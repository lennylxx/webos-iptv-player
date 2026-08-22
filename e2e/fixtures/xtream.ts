import { SAMPLE_M3U, neuterVideo, type Page } from '../helpers';

/**
 * A one-account Xtream portal: one movie, one series with one episode, a
 * playable VOD stream and a stubbed online-subtitle provider. Enough to reach
 * every catalog and VOD-player screen. Call before `page.goto`.
 */
export async function seedXtream(page: Page): Promise<void> {
  await page.route('**/get.php*', (r) => r.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: SAMPLE_M3U,
  }));
  await page.route('**/xmltv.php*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (url.includes('get_vod_categories')) return json([{ category_id: '1', category_name: 'Cat A' }]);
    if (url.includes('get_vod_streams')) {
      return json([{ stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' }]);
    }
    if (url.includes('get_vod_info')) {
      return json({ info: { plot: 'A plot.', duration_secs: 3600,
        subtitles: [{ id: '1', title: 'Sub 1', language: 'l1', url: 'http://host/sub1.srt' }] } });
    }
    if (url.includes('get_series_categories')) return json([{ category_id: '2', category_name: 'Cat B' }]);
    if (url.includes('get_series_info')) {
      return json({
        info: { name: 'Series One', plot: 'A series plot.' },
        episodes: { 1: [{ id: '11', title: 'Episode 1', season: 1, episode_num: 1,
          container_extension: 'mp4', info: { duration_secs: 600, plot: 'An episode.' } }] },
      });
    }
    if (url.includes('get_series')) {
      return json([{ series_id: 20, name: 'Series One', cover: '', category_id: '2' }]);
    }
    return json({});
  });
  await neuterVideo(page);
  await page.route('**/movie/**', (r) => r.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.route('**/sub1.srt', (r) => r.fulfill({ status: 200, contentType: 'text/plain',
    body: '1\n00:00:01,000 --> 00:00:04,000\nA line.\n' }));

  // The subtitle providers are live third-party APIs. Stub them in the page
  // rather than through routing, which the app's own fetch path bypasses.
  await page.addInitScript(() => {
    const real = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      // Assrt reports itself configured unconditionally, so answer it too:
      // otherwise the merged search waits out its timeout on every run.
      if (url.indexOf('api.assrt.net') !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ sub: { subs: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.indexOf('api.opensubtitles.com') === -1) return real.call(window, input, init);
      const body = { token: 't', data: [
        { attributes: { language: 'l1', release: 'Release One', download_count: 12345,
          files: [{ file_id: 1, file_name: 'one.srt' }] } },
        { attributes: { language: 'l2', release: 'Release Two', download_count: 678,
          files: [{ file_id: 2, file_name: 'two.srt' }] } },
      ] };
      return Promise.resolve(new Response(JSON.stringify(body),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
    localStorage.setItem('iptv_online_subtitles', JSON.stringify({
      preferredLanguage: 'l1',
      opensubtitles: { apiKey: 'key', username: 'user', password: 'pass', token: '', tokenTs: 0 },
      subdl: { apiKey: '' },
      assrt: { apiKey: '' },
    }));
  });
}
