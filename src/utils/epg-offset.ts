import { t } from '../i18n';

export function formatEpgOffset(minutes: number): string {
  if (!minutes) return t('settings.offsetZero');
  const sign = minutes > 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  const value = hours
    ? `${String(hours)} ${t('settings.offsetHours')}${
      remainder ? ` ${String(remainder)} ${t('settings.offsetMinutes')}` : ''
    }`
    : `${String(remainder)} ${t('settings.offsetMinutes')}`;
  return `${sign}${value}`;
}
