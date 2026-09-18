import { t } from '../i18n';
import { html, type Safe } from '../utils/dom';

export function liveBadge(extraClass = ''): Safe {
  return html`
    <span class="live-badge ${extraClass}">
      <span class="live-badge-dot" aria-hidden="true"></span>
      <span>${t('common.live')}</span>
    </span>`;
}
