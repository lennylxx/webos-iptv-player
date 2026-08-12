import type { Action, Reminder } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { ReminderService } from '../services/reminder-service';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import {
  addDisplayDays,
  displayDayKey,
  formatDayLabel,
  formatTime,
} from '../utils/time';
import { showToast } from './toast';
import { ConfirmationPrompt } from './confirmation-prompt';
import { BACK_ICON, CLOCK_ICON, REMOVE_ICON, TRASH_ICON } from './icons';

interface ReminderDayGroup {
  key: string;
  label: string;
  date: string;
  reminders: Reminder[];
}

export class ReminderManager {
  private nav: SpatialNav;
  private confirmationPrompt = new ConfirmationPrompt();
  private now = Date.now();

  constructor(
    private container: HTMLElement,
    private onBack: () => void,
  ) {
    this.nav = new SpatialNav(container);
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control);
      this.activate(control);
    });
  }

  get isPromptVisible(): boolean {
    return this.confirmationPrompt.visible;
  }

  open(now = Date.now()): void {
    this.now = now;
    this.render();
    this.focusFirst();
  }

  handleAction(action: Action): void {
    if (this.confirmationPrompt.visible) {
      this.confirmationPrompt.handleAction(action);
      return;
    }
    if (action === 'back') {
      this.onBack();
    } else if (action === 'select' && this.nav.focused) {
      this.activate(this.nav.focused);
    } else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      this.nav.move(action);
    }
  }

  private reminders(): Reminder[] {
    return ReminderService.listManageable(this.now);
  }

  private render(): void {
    const reminders = this.reminders();
    const groups = this.groupByDay(reminders);
    morph(this.container, html`
      <div class="reminder-manager-view">
        <header class="reminder-manager-hero">
          <div class="reminder-manager-actions">
            <button class="reminder-manager-back" data-focusable
                    data-reminder-action="back">
              <span class="reminder-manager-button-icon">${raw(BACK_ICON)}</span>
              ${t('common.back')}
            </button>
            ${reminders.length
              ? html`<button class="reminder-manager-clear" data-focusable
                             data-reminder-action="clear">
                       <span class="reminder-manager-button-icon">${raw(TRASH_ICON)}</span>
                       ${t('reminderManager.clearAll')}
                     </button>`
              : ''}
          </div>
          <div class="reminder-manager-heading">
            <div>
              <h1>${t('reminderManager.title')}</h1>
              <p>${t('reminderManager.summary', { count: reminders.length })}</p>
            </div>
          </div>
        </header>
        ${reminders.length
          ? html`
            <div class="reminder-manager-list">
              ${groups.map(group => this.reminderGroup(group))}
            </div>`
          : html`
            <div class="reminder-manager-empty">
              <p>${t('reminderManager.empty')}</p>
            </div>`}
      </div>
    `);
  }

  private groupByDay(reminders: Reminder[]): ReminderDayGroup[] {
    const now = new Date(this.now);
    const todayKey = displayDayKey(now);
    const tomorrowKey = displayDayKey(addDisplayDays(now, 1));
    const groups: ReminderDayGroup[] = [];
    for (const reminder of reminders) {
      const start = new Date(reminder.startMs);
      const key = displayDayKey(start);
      let group = groups[groups.length - 1];
      if (group?.key !== key) {
        const formatted = formatDayLabel(start);
        const label = key === todayKey
          ? t('reminderManager.today')
          : key === tomorrowKey
            ? t('reminderManager.tomorrow')
            : formatted.weekday;
        group = {
          key,
          label,
          date: formatted.date,
          reminders: [],
        };
        groups.push(group);
      }
      group.reminders.push(reminder);
    }
    return groups;
  }

  private reminderGroup(group: ReminderDayGroup) {
    return html`
      <section class="reminder-day-group" data-key="${group.key}">
        <div class="reminder-day-heading">
          <div class="reminder-day-label">
            <strong>${group.label}</strong>
            <span>${group.date}</span>
          </div>
          <div class="reminder-day-line"></div>
        </div>
        <div class="reminder-day-cards">
          ${group.reminders.map(reminder => this.reminderRow(reminder))}
        </div>
      </section>
    `;
  }

  private reminderRow(reminder: Reminder) {
    const start = new Date(reminder.startMs);
    return html`
      <div class="reminder-manager-row" data-key="${reminder.channelKey}|${reminder.startMs}">
        <time class="reminder-manager-time" datetime="${new Date(reminder.startMs).toISOString()}">
          <span class="reminder-manager-time-icon">${raw(CLOCK_ICON)}</span>
          ${formatTime(start)}
        </time>
        <div class="reminder-manager-details">
          <div class="reminder-manager-program">${reminder.title}</div>
          <div class="reminder-manager-channel">${reminder.channelName}</div>
        </div>
        <button class="reminder-manager-remove" data-focusable
                data-reminder-action="remove" data-channel-key="${reminder.channelKey}"
                data-start-ms="${reminder.startMs}">
          <span class="reminder-manager-button-icon">${raw(REMOVE_ICON)}</span>
          ${t('common.remove')}
        </button>
      </div>
    `;
  }

  private activate(control: HTMLElement): void {
    switch (control.dataset.reminderAction) {
      case 'back':
        this.onBack();
        break;
      case 'remove':
        this.remove(control);
        break;
      case 'clear':
        this.confirmClearAll();
        break;
    }
  }

  private remove(control: HTMLElement): void {
    const buttons = Array.from(
      this.container.querySelectorAll<HTMLElement>('.reminder-manager-remove'),
    );
    const index = buttons.indexOf(control);
    ReminderService.remove(control.dataset.channelKey!, Number(control.dataset.startMs));
    this.render();
    const remaining = Array.from(
      this.container.querySelectorAll<HTMLElement>('.reminder-manager-remove'),
    );
    this.nav.focus(remaining[Math.min(index, remaining.length - 1)]
      ?? this.container.querySelector<HTMLElement>('.reminder-manager-back'));
    showToast(t('reminderManager.removed'));
  }

  private confirmClearAll(): void {
    this.confirmationPrompt.show({
      title: t('reminderManager.clearTitle'),
      message: t('reminderManager.clearMessage'),
      confirmLabel: t('common.clear'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        ReminderService.clearAll();
        this.render();
        this.nav.focus(
          this.container.querySelector<HTMLElement>('.reminder-manager-back'),
        );
        showToast(t('reminderManager.cleared'));
      },
      onCancel: () => {},
    });
  }

  private focusFirst(): void {
    this.nav.focus(
      this.container.querySelector<HTMLElement>('.reminder-manager-remove')
      ?? this.container.querySelector<HTMLElement>('.reminder-manager-back'),
    );
  }
}
