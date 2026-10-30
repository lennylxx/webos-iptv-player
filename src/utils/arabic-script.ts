import { StorageService } from '../services/storage-service';

// Arabic, Arabic Supplement, Arabic Extended-A/B, and the presentation forms.
const ARABIC = /[؀-ۿݐ-ݿࡰ-࢟ࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function hasArabicScript(text: string | undefined): boolean {
  return !!text && ARABIC.test(text);
}

// True when the "Hide Arabic titles" setting is on and any name is in Arabic script.
export function hiddenAsArabic(...names: Array<string | undefined>): boolean {
  if (!StorageService.getHideArabic()) return false;
  for (const name of names) if (hasArabicScript(name)) return true;
  return false;
}
