// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../types';

const { state, reminderMock, toastMock } = vi.hoisted(() => {
  const state = { reminders: [] as Reminder[] };
  return {
    state,
    reminderMock: {
      listManageable: vi.fn(() => state.reminders.slice()
        .sort((a, b) => a.startMs - b.startMs)),
      remove: vi.fn((channelKey: string, startMs: number) => {
        state.reminders = state.reminders
          .filter(r => r.channelKey !== channelKey || r.startMs !== startMs);
      }),
      clearAll: vi.fn(() => { state.reminders = []; }),
    },
    toastMock: vi.fn(),
  };
});

vi.mock('../services/reminder-service', () => ({ ReminderService: reminderMock }));
vi.mock('./toast', () => ({ showToast: toastMock }));

import { ReminderManager } from './reminder-manager';
import { setLocale } from '../i18n';
import { setDisplayTz } from '../utils/time';

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  channelKey: 'ch1',
  channelName: 'Alpha',
  title: 'Program A',
  startMs: 2000,
  stopMs: 5000,
  ...over,
});

let container: HTMLElement;
let onBack: ReturnType<typeof vi.fn>;
let manager: ReminderManager;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  state.reminders = [];
  vi.clearAllMocks();
  setLocale('en');
  setDisplayTz('device', null);
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  onBack = vi.fn();
  manager = new ReminderManager(container, onBack);
});

function click(selector: string): void {
  container.querySelector<HTMLElement>(selector)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('ReminderManager', () => {
  it('renders sorted upcoming reminders with escaped provider text', () => {
    state.reminders = [
      reminder({
        channelKey: 'ch2',
        channelName: '<img src=x onerror=alert(1)>',
        title: 'Later',
        startMs: 3000,
      }),
      reminder({ title: '<b>Earlier</b>', startMs: 2500 }),
    ];

    manager.open(2000);

    const rows = Array.from(container.querySelectorAll('.reminder-manager-row'));
    expect(rows[0].querySelector('.reminder-manager-program')?.textContent)
      .toBe('<b>Earlier</b>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows the empty state and focuses Back when no reminders exist', () => {
    manager.open(2000);

    expect(container.querySelector('.reminder-manager-empty p')?.textContent)
      .toBe('No upcoming reminders.');
    expect(container.querySelector('.reminder-manager-back')?.classList.contains('focused'))
      .toBe(true);
  });

  it('groups reminders under Today and Tomorrow date rails', () => {
    state.reminders = [
      reminder({ startMs: 3000 }),
      reminder({ channelKey: 'ch2', startMs: 24 * 60 * 60 * 1000 + 3000 }),
    ];

    manager.open(2000);

    const labels = Array.from(container.querySelectorAll('.reminder-day-label strong'))
      .map(label => label.textContent);
    expect(labels).toEqual(['Today', 'Tomorrow']);
    expect(container.querySelectorAll('.reminder-day-group')).toHaveLength(2);
  });

  it('formats date rails with the selected app locale', () => {
    setLocale('zh-CN');
    const startMs = new Date(2030, 0, 5, 12).getTime();
    state.reminders = [reminder({ startMs })];

    manager.open(new Date(2030, 0, 1, 12).getTime());

    expect(container.querySelector('.reminder-day-label strong')?.textContent)
      .toBe('周六');
  });

  it('formats day groups and times in the selected EPG timezone', () => {
    setDisplayTz('feed', 120);
    const startMs = Date.UTC(1970, 0, 3, 23, 5);
    state.reminders = [reminder({ startMs })];

    manager.open(Date.UTC(1970, 0, 1, 12));

    expect(container.querySelector('.reminder-day-label strong')?.textContent)
      .toBe('Sun');
    expect(container.querySelector('.reminder-day-label span')?.textContent)
      .toBe('01/04');
    expect(container.querySelector('.reminder-manager-time')?.textContent?.trim())
      .toBe('01:05');
  });

  it('removes one reminder and focuses the next available row', () => {
    state.reminders = [
      reminder({ channelKey: 'ch1', startMs: 3000 }),
      reminder({ channelKey: 'ch2', startMs: 4000 }),
      reminder({ channelKey: 'ch3', startMs: 5000 }),
    ];
    manager.open(2000);

    click('.reminder-manager-remove');

    expect(reminderMock.remove).toHaveBeenCalledWith('ch1', 3000);
    expect(container.querySelector<HTMLElement>('.reminder-manager-remove.focused')
      ?.dataset.channelKey).toBe('ch2');
    expect(toastMock).toHaveBeenCalledWith('Reminder removed');
  });

  it('focuses Back after removing the final reminder', () => {
    state.reminders = [reminder({ startMs: 3000 })];
    manager.open(2000);

    click('.reminder-manager-remove');

    expect(container.querySelector('.reminder-manager-back')?.classList.contains('focused'))
      .toBe(true);
  });

  it('requires confirmation before clearing every reminder', () => {
    state.reminders = [reminder({ startMs: 3000 })];
    manager.open(2000);
    click('.reminder-manager-clear');

    manager.handleAction('select');
    expect(reminderMock.clearAll).not.toHaveBeenCalled();

    click('.reminder-manager-clear');
    manager.handleAction('left');
    manager.handleAction('select');

    expect(reminderMock.clearAll).toHaveBeenCalledOnce();
    expect(container.querySelector('.reminder-manager-empty')).not.toBeNull();
    expect(toastMock).toHaveBeenCalledWith('All reminders cleared');
  });

  it('returns through the Back control', () => {
    manager.open(2000);
    manager.handleAction('back');
    expect(onBack).toHaveBeenCalledOnce();
  });
});
