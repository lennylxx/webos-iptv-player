import * as fs from 'fs';
import * as path from 'path';
import { mkdirRecursive, stringEndsWith } from '../compat';

export interface UploadMeta {
  id: string;
  name: string;
  count: number;
  createdAt: number;
}

/**
 * Probe a list of candidate dirs and return the first writable one. The
 * service install dir is read-only and /tmp is wiped on reboot, so prefer
 * persistent storage. Logs each probe so failures are visible in the device
 * log (you can curl /info or check the service stdout to confirm).
 */
export function resolveDataDir(envOverride?: string): string {
  const candidates: string[] = [
    envOverride,
    '/media/internal/iptv-uploads',
    path.join(__dirname, 'uploads'),
    '/tmp/iptv-uploads',
  ].filter((candidate): candidate is string => !!candidate);

  for (const dir of candidates) {
    try {
      mkdirRecursive(dir);
      const probe = path.join(dir, '.probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      console.log('[upload] resolveDataDir: using ' + dir);
      return dir;
    } catch (e) {
      console.log('[upload] resolveDataDir: candidate ' + dir + ' not writable: ' +
        (e instanceof Error ? e.message : String(e)));
    }
  }

  const fallback = '/tmp/iptv-uploads';
  try { mkdirRecursive(fallback); } catch { /* ignore */ }
  console.warn('[upload] resolveDataDir: all candidates failed, falling back to ' + fallback);
  return fallback;
}

function sanitizeId(name: string): string {
  const base = String(name).replace(/\.m3u8?$/i, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return isValidUploadId(slug) ? slug : 'playlist';
}

export function isValidUploadId(id: string): boolean {
  return /^[a-z0-9._-]{1,60}$/.test(id) && id !== '.' && id !== '..';
}

function countChannels(content: string): number {
  const matches = content.match(/^#EXTINF:/gm);
  return matches ? matches.length : 0;
}

export class UploadStore {
  constructor(private readonly dataDir: string) {}

  private storagePath(id: string, extension: '.json' | '.m3u'): string {
    if (!isValidUploadId(id)) throw new Error('Invalid upload id');
    const resolved = path.resolve(this.dataDir, id + extension);
    const root = path.resolve(this.dataDir) + path.sep;
    if (resolved.indexOf(root) !== 0) throw new Error('Invalid upload path');
    return resolved;
  }

  private metaPath(id: string): string {
    return this.storagePath(id, '.json');
  }

  private filePath(id: string): string {
    return this.storagePath(id, '.m3u');
  }

  list(): UploadMeta[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dataDir);
    } catch {
      return [];
    }
    const out: UploadMeta[] = [];
    for (const file of entries) {
      if (!stringEndsWith(file, '.json')) continue;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(this.dataDir, file), 'utf-8'),
        ) as UploadMeta;
        if (fs.existsSync(this.filePath(meta.id))) out.push(meta);
      } catch {
        // Skip malformed metadata.
      }
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  save(rawName: string, content: string): UploadMeta {
    if (!/#EXTM3U/.test(content) && !/^#EXTINF:/m.test(content)) {
      throw new Error('Not a valid M3U playlist (missing #EXTM3U/#EXTINF)');
    }
    const id = sanitizeId(rawName || 'playlist');
    const name = String(rawName || id).replace(/\.m3u8?$/i, '').trim() || id;
    const meta: UploadMeta = {
      id,
      name,
      count: countChannels(content),
      createdAt: Date.now(),
    };
    const m3uPath = this.filePath(id);
    const jsonPath = this.metaPath(id);
    fs.writeFileSync(m3uPath, content, 'utf-8');
    fs.writeFileSync(jsonPath, JSON.stringify(meta), 'utf-8');
    console.log('[upload] wrote ' + m3uPath + ' (' + content.length + ' bytes)');
    console.log('[upload] wrote ' + jsonPath);
    return meta;
  }

  delete(id: string): boolean {
    let removed = false;
    for (const file of [this.filePath(id), this.metaPath(id)]) {
      try {
        fs.unlinkSync(file);
        console.log('[upload] removed ' + file);
        removed = true;
      } catch { /* file already gone */ }
    }
    return removed;
  }

  read(id: string): string {
    return fs.readFileSync(this.filePath(id), 'utf-8');
  }
}
