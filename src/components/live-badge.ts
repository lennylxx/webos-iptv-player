import { t } from '../i18n';
import { html, type Safe } from '../utils/dom';

export function liveBadge(extraClass = '', key = ''): Safe {
  return html`
    <span class="live-badge ${extraClass}" ${key ? html`data-key="${key}"` : ''}>
      <span class="live-badge-dot" aria-hidden="true"></span>
      <span>${t('common.live')}</span>
    </span>`;
}
