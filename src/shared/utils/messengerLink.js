/* Messenger group chat links that coaches set per team (coaches/{email}.chats)
   and every student sees on their Profile. Only https links on Messenger /
   Facebook hosts are accepted, so a typo or a pasted look-alike link can't
   send students somewhere else. */
const ALLOWED_HOSTS = ['m.me', 'messenger.com', 'facebook.com', 'fb.me', 'fb.com'];

export function isMessengerUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Trims and adds a missing https:// so "m.me/j/abc" is accepted too. */
export function normalizeMessengerUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text.replace(/^http:\/\//i, 'https://') : `https://${text}`;
}
