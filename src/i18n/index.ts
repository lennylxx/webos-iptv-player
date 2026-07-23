import { EN_MESSAGES, type MessageKey } from './en';

export type { MessageKey } from './en';
type Params = Record<string, string | number>;

export function t(key: MessageKey, params?: Params): string {
  let message: string = EN_MESSAGES[key];
  if (!params) return message;
  message = message.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    params[name] === undefined ? token : String(params[name]));
  return message;
}
