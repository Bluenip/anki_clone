import { describe, expect, it } from 'vitest';
import { joinSounds, splitSounds } from '../utils/soundTags';

describe('sound tags in a field', () => {
  it('splits generated pronunciation out of the meaning and puts it back', () => {
    const field = 'Sao lưu dữ liệu [sound:tts-6c635b48d71a5cbee724.wav]';
    const { text, sounds } = splitSounds(field);
    expect(text).toBe('Sao lưu dữ liệu');
    expect(sounds).toEqual(['tts-6c635b48d71a5cbee724.wav']);
    expect(joinSounds(text, sounds)).toBe(field);
    expect(joinSounds('Sao lưu', sounds)).toBe('Sao lưu [sound:tts-6c635b48d71a5cbee724.wav]');
  });
  it('leaves fields without sounds untouched', () => {
    expect(splitSounds('  plain <b>text</b> ')).toEqual({ text: '  plain <b>text</b> ', sounds: [] });
    expect(joinSounds('', ['a.mp3', 'b.mp3'])).toBe('[sound:a.mp3] [sound:b.mp3]');
  });
});
