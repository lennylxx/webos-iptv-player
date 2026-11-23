import { html, type Safe } from '../utils/dom';
import { t } from '../i18n';

/** A mini mock of the app (tab bar, a focused channel tile, list rows, status
 *  dots) whose `var(--…)` colors resolve to the nearest `data-theme`. It is
 *  decorative, so it is hidden from assistive technology. */
export function themePreviewMock(): Safe {
  return html`
    <span class="theme-swatch-preview" aria-hidden="true">
      <span class="tsp-tabs">
        <span class="tsp-tab active">${t('nav.live')}</span>
        <span class="tsp-tab">${t('nav.movies')}</span>
        <span class="tsp-tab">${t('nav.series')}</span>
      </span>
      <span class="tsp-tiles">
        <span class="tsp-tile focus">ch1</span>
        <span class="tsp-tile">ch2</span>
        <span class="tsp-tile">ch3</span>
      </span>
      <span class="tsp-rows">
        <span class="tsp-row">${t('settings.previewChannelOne')}</span>
        <span class="tsp-row muted">${t('settings.previewChannelTwo')}</span>
      </span>
      <span class="tsp-foot">
        <span class="tsp-epg">${t('settings.previewEpgNow')}</span>
        <span class="tsp-dots">
          <span class="tsp-dot dn"></span>
          <span class="tsp-dot su"></span>
          <span class="tsp-dot wa"></span>
        </span>
      </span>
    </span>`;
}
