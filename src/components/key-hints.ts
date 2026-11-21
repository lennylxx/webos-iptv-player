import { html, raw, type Safe } from '../utils/dom';
import { t } from '../i18n';
import { BACK_ICON } from './icons';

// Footer remote-key hints (`.edit-hints`) shared by the channel editor, the
// Live preview list, and the parental manager. `attrs` carries each caller's
// own data-* hooks so its handlers and tests keep their selectors.
type HintAttrs = Record<string, string>;

function attributes(attrs: HintAttrs): Safe {
  return html`${Object.keys(attrs).map(name => {
    if (!/^data-[a-z-]+$/.test(name)) throw new Error(`Invalid hint attribute: ${name}`);
    return html` ${raw(name)}="${attrs[name]}"`;
  })}`;
}

export function backKey(): Safe {
  return html`<span class="edit-key key-back">${raw(BACK_ICON)}</span>`;
}

export function okHint(label: string, attrs: HintAttrs = {}): Safe {
  return html`<span class="edit-hint"${attributes(attrs)}><span class="edit-key key-ok">OK</span><span>${label}</span></span>`;
}

export function keyHint(key: 'red' | 'green' | 'blue', label: string, dataKey: string, attrs: HintAttrs): Safe {
  return html`<button class="edit-hint edit-action" data-key="${dataKey}" data-focusable${attributes(attrs)}><span class="edit-key key-${key}"></span><span>${label}</span></button>`;
}

// A legend key the pointer may also click; it never takes the remote's keys.
export function clickHint(key: 'red' | 'green' | 'blue', label: string, dataKey: string, attrs: HintAttrs): Safe {
  return html`<button type="button" class="edit-hint edit-action" data-key="${dataKey}" data-self-activate${attributes(attrs)}><span class="edit-key key-${key}"></span><span>${label}</span></button>`;
}

export function doneHint(dataKey: string, attrs: HintAttrs): Safe {
  return html`
    <button class="edit-hint edit-action" data-key="${dataKey}" data-focusable${attributes(attrs)}>
      <span class="edit-key key-yellow"></span>
      <span class="edit-key-separator">/</span>
      ${backKey()}
      <span>${t('channel.editDone')}</span>
    </button>`;
}
