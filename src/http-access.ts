import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface RequestAccessConfig {
  teamDomain?: string;
  lanHosts: string[];
}
export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function requestAccessConfig(env: NodeJS.ProcessEnv, lanHosts: string[]): RequestAccessConfig {
  return { teamDomain: env.ACCESS_TEAM_DOMAIN, lanHosts };
}
function privatePeer(address = '') {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (!isIP(a)) return false;
  const parts = a.split('.').map(Number);
  return a === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(a) || /^fe[89ab][0-9a-f]:/i.test(a)
    || (parts.length === 4 && (parts[0] === 10 || parts[0] === 127
      || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)));
}
const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** Private HTTP listener only. Public snapshot listeners must not use this guard. */
export async function authorizeRequest(req: IncomingMessage, pathname: string, config: RequestAccessConfig, keys?: JWTVerifyGetKey) {
  let host: string;
  try {
    const raw = req.headers.host;
    if (!raw || /[\s/@?#\\]/.test(raw)) throw new Error();
    const url = new URL('http://' + raw);
    if (url.host.toLowerCase() !== raw.toLowerCase()) throw new Error();
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch { throw new AccessError(400, 'Invalid Host header.'); }
  const token = req.headers['cf-access-jwt-assertion'];
  const proxied = ['cf-ray', 'cf-connecting-ip', 'cdn-loop', 'cf-visitor', 'cf-access-jwt-assertion'].some(h => h in req.headers);
  const localHost = host === 'localhost' || privatePeer(host) || config.lanHosts.some(h => h.toLowerCase() === host);
  if (!proxied && localHost && privatePeer(req.socket.remoteAddress)) return { via: 'lan' as const };
  if (typeof token !== 'string' || !token) throw new AccessError(401, 'Cloudflare Access authentication is required.');
  // The audience (which Access application issued the token) is not checked: every application in the team
  // admits only the owner, and a pinned audience tag broke sign-in whenever an application was recreated.
  if (!config.teamDomain) throw new AccessError(503, 'Cloudflare Access is not configured.');
  try {
    const issuer = new URL(config.teamDomain);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.pathname !== '/' || issuer.search || issuer.hash)
      throw new Error();
    if (!keys && !remoteKeys.has(issuer.origin))
      remoteKeys.set(issuer.origin, createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), { timeoutDuration: 5000 }));
    const { payload } = await jwtVerify(token, keys ?? remoteKeys.get(issuer.origin)!, {
      issuer: issuer.origin, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw new Error();
    return { via: 'access' as const, subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
  } catch { throw new AccessError(403, 'Cloudflare Access token is invalid for this route.'); }
}
