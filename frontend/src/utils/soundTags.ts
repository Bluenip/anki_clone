const SOUND = /\[sound:([^\]]+)\]/g;

/** Split a field into its visible text and its [sound:...] file names. */
export function splitSounds(value: string): { text: string; sounds: string[] } {
  const sounds = [...(value || '').matchAll(SOUND)].map(match => match[1]);
  if (!sounds.length) return { text: value || '', sounds };
  return { text: value.replace(SOUND, '').replace(/[ \t]+(\n|$)/g, '$1').replace(/\s+$/, ''), sounds };
}

/** Put text and sound tags back together; sounds go after the text, separated by a space. */
export function joinSounds(text: string, sounds: string[]): string {
  if (!sounds.length) return text;
  const tags = sounds.map(name => `[sound:${name}]`).join(' ');
  return text.trim() ? `${text} ${tags}` : tags;
}
