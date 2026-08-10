import type { PlaylistEntry } from '../types';
import { fetchWithTimeout } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import { genPlaylistId } from '../utils/playlist-id';
import { serviceBase } from './service-http';
import { StorageService } from './storage-service';

const log = createLogger('Upload');

const TIMEOUT = 4000;

export interface UploadMeta {
  id: string;
  name: string;
  count: number;
  createdAt: number;
  url: string;
}

/** Derive the stored upload id from its /uploads/<id>.m3u serve URL. */
export function uploadIdFromUrl(url: string): string {
  const m = url.match(/\/uploads\/([^/]+?)(?:\.m3u)?$/i);
  return m ? decodeURIComponent(m[1]) : '';
}

class UploadClientImpl {
  /** Returns the stored uploads, or null if the service is unreachable. */
  async list(): Promise<UploadMeta[] | null> {
    const b = serviceBase();
    if (!b) {
      log.debug('list skipped: service port not yet known');
      return null;
    }
    try {
      const res = await fetchWithTimeout(`${b}/uploads`, {}, TIMEOUT);
      if (!res.ok) {
        log.warn('list: HTTP', res.status);
        return null;
      }
      const items = (await res.json()) as UploadMeta[];
      return items.map((it) => ({
        ...it,
        url: it.url || `${b}/uploads/${encodeURIComponent(it.id)}.m3u`,
      }));
    } catch (e) {
      log.debug('list failed (service likely not running):', e);
      return null;
    }
  }

  /** Returns true only when the server confirms the upload was deleted. */
  async remove(id: string): Promise<boolean> {
    const b = serviceBase();
    if (!b) {
      log.debug('remove skipped: service port not yet known');
      return false;
    }
    try {
      const res = await fetchWithTimeout(`${b}/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }, TIMEOUT);
      if (!res.ok) {
        log.warn('remove: HTTP', res.status, 'for id', id);
        return false;
      }
      return true;
    } catch (e) {
      log.warn('remove failed:', e);
      return false;
    }
  }

  /**
   * Sync uploaded playlists into stored playlists. Full sync (add + remove of
   * 'upload' entries) but only when the list loads successfully — never
   * reconcile-delete when the service is unreachable. User-entered playlists
   * (source !== 'upload') are never touched.
   */
  async reconcile(): Promise<void> {
    const uploads = await this.list();
    if (uploads === null) {
      log.info('LAN service unreachable — skipping upload reconcile');
      return;
    }

    const existing = StorageService.getPlaylists();
    const manual = existing.filter((p) => p.source !== 'upload');
    const prevUpload = existing.filter((p) => p.source === 'upload');
    const uploadEntries: PlaylistEntry[] = uploads.map((u) => ({
      // The HTTP port can change after a service restart, so preserve identity
      // by the stable upload path id rather than the full serve URL.
      id: prevUpload.find((p) => uploadIdFromUrl(p.url) === u.id)?.id ?? genPlaylistId(),
      name: u.name,
      url: u.url,
      source: 'upload',
      count: u.count,
    }));

    const changed =
      prevUpload.length !== uploadEntries.length ||
      uploadEntries.some((u) => !prevUpload.some(
        (p) => p.url === u.url && p.name === u.name && p.count === u.count,
      ));

    if (!changed) {
      log.debug('Uploads already in sync:', uploadEntries.length);
      return;
    }

    StorageService.setPlaylists([...manual, ...uploadEntries]);
    log.info('Reconciled uploads:', uploadEntries.length, 'upload playlist(s)');
  }
}

export const UploadClient = new UploadClientImpl();
