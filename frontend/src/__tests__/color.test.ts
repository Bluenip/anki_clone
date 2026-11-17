import { describe, expect, it } from 'vitest';
import { luminance } from '../utils/color';

describe('luminance', () => {
  it('ranks white, black and transparent colors', () => {
    expect(luminance('rgb(255, 255, 255)')).toBeCloseTo(1);
    expect(luminance('rgb(0, 0, 0)')).toBe(0);
    expect(luminance('rgba(0, 0, 0, 0)')).toBeNull();
    expect(luminance('rgb(30, 41, 59)')!).toBeLessThan(0.1);
    expect(luminance('transparent')).toBeNull();
  });
});
