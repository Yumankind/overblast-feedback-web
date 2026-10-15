/**
 * Redaction, applied to every log line before it is stored and to every url before it is sent
 * (contract §6). It is a set of shapes, not a guarantee: it catches the secrets that look like
 * secrets. Anything an integrator knows to be sensitive should not be logged in the first place.
 */

export const REDACTED = '[redacted]';
/** A log line's longest message (contract §3.1). */
export const MAX_LOG_MSG = 4000;

/** `Bearer abc…`: the scheme word stays, the credential goes. */
const BEARER = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi;
/** `Basic dXNlcjpwYXNz`: only when it looks like base64 (a digit, a `+`, a `/` or padding), so prose survives. */
const BASIC = /\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g;

/** JSON Web Tokens: three base64url parts, the first of which always starts with `{"` encoded. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

/**
 * API keys by their published prefixes: OpenAI and Anthropic (`sk-…`), Stripe (`sk_live_`,
 * `rk_test_`, `pk_live_`, `whsec_`), Overblast (`ob_live_`, `ob_test_`, `obfk_`), GitHub (`ghp_`,
 * `gho_`, `github_pat_`), Slack (`xoxb-`), AWS access key ids, Google API keys.
 */
const API_KEYS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bob_(?:live|test)_[A-Za-z0-9_-]{8,}/g,
  /\bobfk_[A-Za-z0-9]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
];

/**
 * `password=…`, `"token": "…"`, `api_key: …`. The name stays so the line still says what was
 * there; the value goes. Quoted values keep their quotes so a JSON line stays readable.
 */
const SECRET_PAIR =
  /(["']?)\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|session[_-]?id|credentials?))\1(\s*[:=]\s*)(\[redacted\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&,;"'}\]]+)/gi;

/**
 * 13 to 19 digits, optionally grouped by spaces or dashes. Only redacted when the Luhn check
 * passes AND the first digit is one a card network issues (2 to 6), which keeps millisecond
 * timestamps (they start with 1) and most order numbers out of it.
 */
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardLike(match: string): boolean {
  const digits = match.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  const first = digits.charCodeAt(0) - 48;
  if (first < 2 || first > 6) return false;
  return luhn(digits);
}

/** Replace everything that looks like a credential or a card number with `[redacted]`. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(BASIC, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(JWT, REDACTED);
  for (const re of API_KEYS) out = out.replace(re, REDACTED);
  out = out.replace(SECRET_PAIR, (_m, q: string, name: string, sep: string, value: string) => {
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
    return `${q}${name}${q}${sep}${quote}${REDACTED}${quote}`;
  });
  out = out.replace(CARD, (m) => (cardLike(m) ? REDACTED : m));
  return out;
}

/** Query parameter names whose values are never sent (compared lower-cased). */
const SECRET_PARAMS = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth',
  'authorization',
  'key',
  'api_key',
  'apikey',
  'code',
  'password',
  'pass',
  'secret',
  'client_secret',
  'signature',
  'sig',
  'session',
  'sessionid',
  'session_id',
  'state',
  'otp',
  'jwt',
]);

function absolute(url: string): URL | null {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return new URL(url, base);
  } catch {
    return null;
  }
}

/**
 * The page's own address for `context.url`: the fragment is dropped, the query string is kept
 * (contract §3.1) with the values of token-like parameters replaced, and the rest redacted as a
 * log line would be. At most 2000 characters.
 */
export function contextUrl(url: string): string {
  const u = absolute(url);
  if (!u) return redact(url.split('#')[0] ?? '').slice(0, 2000);
  let query = '';
  if (u.search.length > 1) {
    const parts = u.search
      .slice(1)
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        let name = pair.slice(0, eq);
        try {
          name = decodeURIComponent(name.replace(/\+/g, ' '));
        } catch {
          /* a malformed escape: compare it as written */
        }
        return SECRET_PARAMS.has(name.toLowerCase()) ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
      });
    query = `?${parts.join('&')}`;
  }
  return redact(`${u.origin === 'null' ? `${u.protocol}//` : u.origin}${u.pathname}${query}`).slice(0, 2000);
}

/** A request's address for `network[].url`: no query string, no fragment (contract §6), ≤ 500. */
export function networkUrl(url: string): string {
  const u = absolute(url);
  if (!u) return redact(url.split(/[?#]/)[0] ?? '').slice(0, 500);
  if (u.protocol === 'data:' || u.protocol === 'blob:') return `${u.protocol}…`;
  return redact(`${u.origin === 'null' ? `${u.protocol}//` : u.origin}${u.pathname}`).slice(0, 500);
}

/** Redact first, then cut, so a cut can never leave half a token that no longer matches. */
export function cleanMessage(text: string): string {
  const pre = text.length > MAX_LOG_MSG * 4 ? text.slice(0, MAX_LOG_MSG * 4) : text;
  const out = redact(pre);
  return out.length > MAX_LOG_MSG ? `${out.slice(0, MAX_LOG_MSG - 1)}…` : out;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
