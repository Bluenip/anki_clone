import { describe, it, expect } from 'vitest';
import { validationText } from '../api/client';

describe('validationText', () => {
  it('turns FastAPI validation issues into readable text', () => {
    expect(validationText([
      { loc: ['body', 'email'], msg: 'value is not a valid email address' },
      { loc: ['body', 'username'], msg: 'Value error, Username is required' },
    ])).toBe('email: value is not a valid email address\nusername: Username is required');
  });

  it('never returns an empty message', () => {
    expect(validationText([{}, null])).toBe('Invalid request');
  });
});
