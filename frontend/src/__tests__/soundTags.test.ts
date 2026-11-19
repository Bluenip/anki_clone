import { describe, expect, it } from 'vitest';
import { joinSounds, splitSounds, tidySoundField } from '../utils/soundTags';

describe('sound tags in a field', () => {
  it('splits generated pronunciation out of the meaning and puts it back', () => {
    const field = 'Sao lưu dữ liệu [sound:tts-6c635b48d71a5cbee724.wav]';
    const { text, sounds } = splitSounds(field);
    expect(text).toBe('Sao lưu dữ liệu');
    expect(sounds).toEqual(['tts-6c635b48d71a5cbee724.wav']);
    expect(joinSounds(text, sounds)).toBe(field);
    expect(joinSounds('Sao lưu', sounds)).toBe('Sao lưu [sound:tts-6c635b48d71a5cbee724.wav]');
  });
  it('keeps what is being typed before the sound: spaces and new lines', () => {
    const sounds = ['tts-6c635b48d71a5cbee724.wav'];
    for (const typed of ['tích trữ ', 'tích trữ  ', 'tích trữ\n', 'tích trữ\nnghĩa', ' ']) {
      expect(splitSounds(joinSounds(typed, sounds))).toEqual({ text: typed, sounds });
    }
  });
  it('drops spaces left before the sound when the field is saved', () => {
    expect(tidySoundField('mơ hồ, nước đôi   [sound:a.wav]')).toBe('mơ hồ, nước đôi [sound:a.wav]');
    expect(tidySoundField('nghĩa\n [sound:a.wav]')).toBe('nghĩa [sound:a.wav]');
    expect(tidySoundField(' [sound:a.wav]')).toBe('[sound:a.wav]');
    expect(tidySoundField('no sound  ')).toBe('no sound  ');
  });
  it('leaves fields without sounds untouched', () => {
    expect(splitSounds('  plain <b>text</b> ')).toEqual({ text: '  plain <b>text</b> ', sounds: [] });
    expect(joinSounds('', ['a.mp3', 'b.mp3'])).toBe('[sound:a.mp3] [sound:b.mp3]');
  });
});
