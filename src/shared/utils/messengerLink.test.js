import { describe, it, expect } from 'vitest';
import { isMessengerUrl, normalizeMessengerUrl } from './messengerLink';

describe('isMessengerUrl', () => {
  it('accepts Messenger / Facebook links', () => {
    expect(isMessengerUrl('https://m.me/j/AbC123')).toBe(true);
    expect(isMessengerUrl('https://www.messenger.com/t/123')).toBe(true);
    expect(isMessengerUrl('https://www.facebook.com/messages/t/123')).toBe(true);
  });

  it('rejects other hosts, look-alikes and non-https', () => {
    expect(isMessengerUrl('https://example.com/m.me')).toBe(false);
    expect(isMessengerUrl('https://m.me.evil.com/j/x')).toBe(false);
    expect(isMessengerUrl('https://notfacebook.com/x')).toBe(false);
    expect(isMessengerUrl('http://m.me/j/x')).toBe(false);
    expect(isMessengerUrl('javascript:alert(1)')).toBe(false);
    expect(isMessengerUrl('')).toBe(false);
  });
});

describe('normalizeMessengerUrl', () => {
  it('adds https:// and upgrades http', () => {
    expect(normalizeMessengerUrl(' m.me/j/abc ')).toBe('https://m.me/j/abc');
    expect(normalizeMessengerUrl('http://m.me/j/abc')).toBe('https://m.me/j/abc');
    expect(normalizeMessengerUrl('')).toBe('');
  });
});
