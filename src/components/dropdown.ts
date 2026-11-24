import { html, type Safe } from '../utils/dom';
import type { SpatialNav } from '../navigation/spatial-nav';

/** Custom single-select dropdown — remote/D-pad friendly and app-styled (the app
 *  uses no native `<select>`). The trigger toggles the menu; each option carries a
 *  `data-dropdown-value`; the chosen value lives on the root's `data-value`. */
export function dropdown(
  id: string,
  options: { value: string; label: string }[],
  active: string,
): Safe {
  const current = options.find(o => o.value === active) ?? options[0];
  return html`
    <div class="dropdown" id="${id}" data-value="${active}">
      <span class="dropdown-sizer" aria-hidden="true">
        ${options.map(o => html`<span>${o.label}</span>`)}
      </span>
      <button class="dropdown-trigger" data-focusable data-dropdown-trigger
              data-key="${id}:trigger" aria-expanded="false">
        <span class="dropdown-current">${current.label}</span>
        <span class="dropdown-caret"></span>
      </button>
      <div class="dropdown-menu">
        ${options.map(o => html`
          <button class="dropdown-option ${o.value === active ? 'active' : ''}"
                  data-focusable data-key="${id}:${o.value}"
                  data-dropdown-value="${o.value}">${o.label}</button>
        `)}
      </div>
    </div>`;
}

export function toggleDropdown(
  container: HTMLElement,
  nav: SpatialNav,
  dd: HTMLElement | null,
): void {
  if (!dd) return;
  const open = !dd.classList.contains('open');
  const current = container.querySelector<HTMLElement>('.dropdown.open');
  if (current && current !== dd) closeDropdown(nav, current);
  if (!open) {
    closeDropdown(nav, dd);
    return;
  }
  dd.classList.add('open');
  dd.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'true');
  const opt = dd.querySelector<HTMLElement>('.dropdown-option.active')
    ?? dd.querySelector<HTMLElement>('.dropdown-option');
  if (opt) nav.focus(opt);
}

export function closeDropdown(nav: SpatialNav, dd: HTMLElement): void {
  dd.classList.remove('open');
  dd.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
  const trigger = dd.querySelector<HTMLElement>('.dropdown-trigger');
  if (trigger) nav.focus(trigger);
}

// Record the chosen option on the root's data-value, update the trigger label,
// and close the menu. Callers apply side effects, then refocus the trigger.
export function commitDropdownOption(el: HTMLElement): HTMLElement | null {
  const dd = el.closest<HTMLElement>('.dropdown');
  if (!dd) return null;
  dd.dataset.value = el.dataset.dropdownValue ?? '';
  dd.querySelectorAll('.dropdown-option').forEach(o => o.classList.remove('active'));
  el.classList.add('active');
  const cur = dd.querySelector('.dropdown-current');
  if (cur) cur.textContent = el.textContent;
  dd.classList.remove('open');
  dd.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
  return dd;
}

/** Shows another value without opening or closing the menu, or moving focus. */
export function setDropdownValue(dd: HTMLElement, value: string): void {
  const option = dd.querySelector<HTMLElement>(`[data-dropdown-value="${value}"]`);
  if (!option) return;
  dd.dataset.value = value;
  dd.querySelectorAll('.dropdown-option').forEach(o => o.classList.toggle('active', o === option));
  const cur = dd.querySelector('.dropdown-current');
  if (cur) cur.textContent = option.textContent;
}
