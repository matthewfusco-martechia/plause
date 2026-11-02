import type { Env } from '../../../packages/contracts/src/index';
import { equalSecret, sha256 } from '../../../packages/security/src/index';

const MAX_AUTHORIZATION_LENGTH = 1024;
const CHALLENGE = 'Basic realm="Plause staging", charset="UTF-8"';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function blocked(status: 401 | 503): Response {
  return Response.json({ error: status === 401 ? 'staging_access_required' : 'staging_access_unavailable' }, {
    status,
    headers: { 'cache-control': 'no-store', vary: 'Authorization', ...(status === 401 ? { 'www-authenticate': CHALLENGE } : {}) },
  });
}

function passwordFrom(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization || authorization.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match?.[1]) return null;
  try {
    const decoded = atob(match[1]);
    if (btoa(decoded) !== match[1]) return null;
    const credentials = decoder.decode(Uint8Array.from(decoded, (character) => character.charCodeAt(0)));
    const separator = credentials.indexOf(':');
    if (separator < 0 || credentials.slice(0, separator) !== 'plause') return null;
    const password = credentials.slice(separator + 1);
    return password.length > 0 && password.length <= 256 && !/[\x00-\x1f\x7f]/.test(password) ? password : null;
  } catch { return null; }
}

/** An origin-wide staging wall, independent of Google identity and account permissions. */
export async function stagingAccessResponse(request: Request, env: Env): Promise<Response | null> {
  if (env.STAGING_ACCESS_ENABLED === undefined || env.STAGING_ACCESS_ENABLED === 'false') return null;
  if (env.STAGING_ACCESS_ENABLED !== 'true' || env.APP_ENV !== 'staging'
      || new URL(request.url).protocol !== 'https:' || !/^[a-f0-9]{64}$/i.test(env.STAGING_ACCESS_PASSWORD_SHA256 ?? '')) {
    return blocked(503);
  }
  const password = passwordFrom(request);
  if (password === null) return blocked(401);
  try {
    // The stored value is the digest of a generated high-entropy password, never plaintext.
    // equalSecret uses native Web Crypto HMAC verification for secret comparison.
    return await equalSecret(await sha256(password), env.STAGING_ACCESS_PASSWORD_SHA256!.toLowerCase()) ? null : blocked(401);
  } catch { return blocked(503); }
}
