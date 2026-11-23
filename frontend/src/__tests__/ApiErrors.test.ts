import { describe, it, expect, afterEach } from 'vitest';
import client, { validationText } from '../api/client';

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

describe('a stale token', () => {
  const realLocation = window.location;
  afterEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'location', { value: realLocation, configurable: true, writable: true });
  });

  const at = (pathname: string) => {
    const fake = { pathname, href: `http://localhost${pathname}` };
    Object.defineProperty(window, 'location', { value: fake, configurable: true, writable: true });
    return fake;
  };
  const fail401 = (url: string) => {
    const handler = (client.interceptors.response as any).handlers[0].rejected;
    return handler({ config: { url }, response: { status: 401, data: {} } }).catch(() => undefined);
  };

  it('does not send a visitor on a reset link to the login page', async () => {
    const location = at('/reset-password');
    localStorage.setItem('token', 'expired');
    await fail401('/api/decks');
    expect(location.href).toBe('http://localhost/reset-password');
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('leaves the app-load session check to the sign-in flow', async () => {
    const location = at('/decks');
    await fail401('/api/auth/me');
    expect(location.href).toBe('http://localhost/decks');
  });

  it('still sends a signed-out user on a private page to the login page', async () => {
    const location = at('/decks');
    await fail401('/api/decks');
    expect(location.href).toBe('/login');
  });
});
