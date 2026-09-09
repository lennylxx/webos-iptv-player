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

  async prepare(
    config: PlayReadyConfig,
    onRightsError: (response: ServiceResponse) => void,
  ): Promise<string | null> {
    const generation = ++this.generation;
    await this.unloadCurrent();
    if (generation !== this.generation) return null;

    if (!isLunaAvailable()) throw new Error('webOS DRM service is unavailable');

    try {
      const loaded = await this.call('load', {
        drmType: 'playready',
        appId: __APP_ID__,
      });
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
    await this.call('unload', { clientId });
  }
}
