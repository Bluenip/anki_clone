import { en, type MessageKey } from './en';
import { tNow } from '../context/prefs-context-base';

// Backend errors arrive as English `detail` strings; the `err.*` keys hold those exact texts.
const byText = new Map<string, MessageKey>(
  (Object.keys(en) as MessageKey[]).filter(k => k.startsWith('err.')).map(k => [en[k], k]),
);

export const translateServerError = (detail: string): string => {
  const key = byText.get(detail);
  if (key) return tNow(key);
  const tooLarge = /^File too large\. Maximum allowed size is (\d+) MiB\.$/.exec(detail);
  if (tooLarge) return tNow('err.file_too_large_maximum_allowed_size_is_size_mib', { size: tooLarge[1] });
  return detail;
};
