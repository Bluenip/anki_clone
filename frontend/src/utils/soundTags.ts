const SOUND = /\[sound:([^\]]+)\]/g;
// A tag together with the single space that separates it from what comes before.
const SOUND_WITH_SEPARATOR = / ?\[sound:[^\]]+\]/g;

/** Split a field into its visible text and its [sound:...] file names.
 *  Exact inverse of joinSounds, so whatever is typed (a trailing space, a new line) survives the round trip. */
export function splitSounds(value: string): { text: string; sounds: string[] } {
  const sounds = [...(value || '').matchAll(SOUND)].map(match => match[1]);
  if (!sounds.length) return { text: value || '', sounds };
  return { text: value.replace(SOUND_WITH_SEPARATOR, ''), sounds };
}

/** Put text and sound tags back together; sounds go after the text, each after one space. */
export function joinSounds(text: string, sounds: string[]): string {
  if (!sounds.length) return text;
  const tags = sounds.map(name => `[sound:${name}]`).join(' ');
  return text ? `${text} ${tags}` : tags;
}
