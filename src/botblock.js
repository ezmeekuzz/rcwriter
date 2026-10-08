// Recognises bot-protection and rate-limit responses from common hosts and
// firewalls, so RCWriter can say what happened instead of a confusing error.

function botBlock(res, text = '') {
  const h = (k) => (res.headers && res.headers.get(k)) || '';
  const body = String(text || '').slice(0, 5000);
  if (h('sg-captcha') || /\/\.well-known\/sgcaptcha\//.test(body)) {
    return { provider: 'SiteGround', message: "The website's host (SiteGround) answered with its anti-bot check instead of the page, so RCWriter couldn't read it. This usually happens after many quick requests from the same internet connection. It normally clears by itself within a few hours. To stop it happening, ask SiteGround support to whitelist your internet (IP) address for this site." };
  }
  if (h('cf-mitigated') === 'challenge' || ([403, 503].includes(res.status) && /cf-chl|challenge-platform|Just a moment\.\.\./i.test(body))) {
    return { provider: 'Cloudflare', message: "Cloudflare's bot protection blocked RCWriter. In Cloudflare, add a WAF custom rule that skips the challenge for your IP address (or for /wp-json/), then try again." };
  }
  if (/Sucuri WebSite Firewall|sucuri\.net\/privacy-policy/i.test(body)) {
    return { provider: 'Sucuri', message: "The Sucuri firewall blocked RCWriter. Whitelist your IP address in the Sucuri dashboard (Firewall, Access Control), then try again." };
  }
  if ([403, 503].includes(res.status) && /wordfence/i.test(body)) {
    return { provider: 'Wordfence', message: "Wordfence blocked RCWriter. In WordPress, open Wordfence, Firewall, and allowlist your IP address (or unblock it under Blocking), then try again." };
  }
  if (res.status === 403 && h('host-header') && /<title>\s*403 - Forbidden\s*<\/title>/i.test(body)) {
    return { provider: 'SiteGround', message: "SiteGround's firewall refused RCWriter's request (403 Forbidden). If it keeps happening, ask SiteGround support to allow RCWriter for this site, and include your internet (IP) address." };
  }
  if (res.status === 429) {
    return { provider: 'rate limit', message: 'The website is limiting how many requests it accepts (HTTP 429). Wait a while and try again.' };
  }
  return null;
}

class BlockedError extends Error {
  constructor(info) { super(info.message); this.blocked = info; }
}

module.exports = { botBlock, BlockedError };
