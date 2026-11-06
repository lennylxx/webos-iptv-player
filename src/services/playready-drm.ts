import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import type { PlayReadyConfig } from './drm-config';
import {
  isLunaAvailable,
  lunaRequest,
  type LunaRequestHandle,
} from './luna';

const log = createLogger('PlayReady');
const DRM_URI = 'luna://com.webos.service.drm';
const PLAYREADY_SYSTEM_ID = 'urn:dvb:casystemid:19219';
const PLAYREADY_MESSAGE_TYPE = 'application/vnd.ms-playready.initiator+xml';

interface ServiceResponse {
  returnValue?: boolean;
  clientId?: string;
  msgId?: string;
  resultCode?: number;
  errorCode?: number;
  errorText?: string;
  contentId?: string;
  errorState?: number;
  rightIssueUrl?: string;
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function licenseServerMessage(url: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<PlayReadyInitiator xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols/">'
    + '<LicenseServerUriOverride><LA_URL>' + xml(url) + '</LA_URL>'
    + '</LicenseServerUriOverride></PlayReadyInitiator>';
}

function customDataMessage(customData: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<PlayReadyInitiator xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols/">'
    + '<SetCustomData><CustomData>' + xml(customData) + '</CustomData>'
    + '</SetCustomData></PlayReadyInitiator>';
}

export class PlayReadyDrm {
  private generation = 0;
  private clientId = '';
  private subscription: LunaRequestHandle | null = null;
  private messageIds = new Set<string>();
  // Unloads and loads still in flight. The service may hand a new load the
  // clientId an earlier unload is about to delete, so a load waits them out.
  private pending = new Set<Promise<void>>();

  async prepare(
    config: PlayReadyConfig,
    onRightsError: (response: ServiceResponse) => void,
  ): Promise<string | null> {
    const generation = ++this.generation;
    await this.unloadCurrent();
    await this.settlePending();
    if (generation !== this.generation) return null;

    if (!isLunaAvailable()) throw new Error('webOS DRM service is unavailable');

    try {
      // A load superseded while in flight unloads its client before a newer
      // prepare may load.
      const loading = this.call('load', {
        drmType: 'playready',
        appId: __APP_ID__,
      }).then(async response => {
        if (generation === this.generation || !response.clientId) return response;
        await this.unload(response.clientId);
        return null;
      });
      this.track(loading);
      const loaded = await loading;
      if (!loaded) return null;
      const clientId = loaded.clientId;
      if (!clientId) throw new Error('DRM service returned no clientId');
      if (generation !== this.generation) {
        await this.unload(clientId);
        return null;
      }
      this.clientId = clientId;
      this.messageIds.clear();
      this.subscription = lunaRequest<ServiceResponse>(DRM_URI, {
        method: 'getRightsError',
        parameters: { clientId, subscribe: true },
        onSuccess: response => {
          if (generation !== this.generation || typeof response.errorState !== 'number') return;
          if (!response.contentId || !this.messageIds.has(response.contentId)) return;
          onRightsError(response);
        },
        onFailure: error => {
          if (generation === this.generation) {
            log.warn('Rights-error subscription failed',
              `code=${String(error.errorCode ?? '')}`);
          }
        },
      });

      const messages = [licenseServerMessage(config.licenseUrl)];
      if (config.customData) messages.push(customDataMessage(config.customData));
      for (const msg of messages) {
        const sent = await this.call('sendDrmMessage', {
          clientId,
          msgType: PLAYREADY_MESSAGE_TYPE,
          msg,
          drmSystemId: PLAYREADY_SYSTEM_ID,
        });
        if (sent.resultCode !== undefined && sent.resultCode !== 0) {
          throw new Error(`PlayReady message failed with result ${String(sent.resultCode)}`);
        }
        if (sent.msgId) this.messageIds.add(sent.msgId);
        if (generation !== this.generation) return null;
      }
      return clientId;
    } catch (error) {
      if (generation === this.generation) await this.unloadCurrent();
      throw error;
    }
  }

  release(): void {
    this.generation++;
    void this.unloadCurrent().catch(error => {
      log.warn('DRM client unload failed', error);
    });
  }

  private call(
    method: string,
    parameters: Record<string, unknown>,
  ): Promise<ServiceResponse> {
    return new Promise((resolve, reject) => {
      lunaRequest<ServiceResponse>(DRM_URI, {
        method,
        parameters,
        onSuccess: response => {
          if (response.returnValue === false) {
            reject(new Error(response.errorText || `${method} failed`));
            return;
          }
          resolve(response);
        },
        onFailure: error => {
          reject(new Error(error.errorText || `${method} failed`));
        },
      });
    });
  }

  private async unloadCurrent(): Promise<void> {
    const clientId = this.clientId;
    this.clientId = '';
    this.messageIds.clear();
    this.subscription?.cancel();
    this.subscription = null;
    if (isLunaAvailable() && clientId) await this.unload(clientId);
  }

  private async unload(clientId: string): Promise<void> {
    const unloading = this.call('unload', { clientId });
    this.track(unloading);
    await unloading;
  }

  private track(work: Promise<unknown>): void {
    const settled = work.then(() => {}, () => {});
    this.pending.add(settled);
    void settled.then(() => { this.pending.delete(settled); });
  }

  // Bounded, so an unload the service never answers cannot hold playback.
  private settlePending(): Promise<void> {
    const waiting = Array.from(this.pending);
    if (!waiting.length) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        for (const work of waiting) this.pending.delete(work);
        log.warn('DRM client unload unanswered', 'event=playback.dash.drm.unload.timeout',
          `pending=${String(waiting.length)}`);
        resolve();
      }, CONFIG.PLAYER.PLAYREADY_UNLOAD_WAIT_MS);
      void Promise.all(waiting).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
