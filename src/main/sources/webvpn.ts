import { createCipheriv } from 'node:crypto';

/**
 * 复旦 WebVPN（webvpn.fudan.edu.cn）的地址改写。
 *
 * 校外访问只对校内开放的服务（如树洞、旦克）时，把原地址改写成 WebVPN 地址：
 *   https://forum.fduhole.com/api/x → https://webvpn.fudan.edu.cn/https/<加密的主机名>/api/x
 * 主机名用 AES-128-CFB 加密，密钥和 IV 都是 WebVPN 系统公开约定的 "wrdvpnisthebest!"
 * （DanXi 等复旦同学的开源项目都按这个规则访问）。登录 WebVPN 复用复旦统一身份认证。
 */
export const WEBVPN_HOST = 'webvpn.fudan.edu.cn';
export const WEBVPN_LOGIN_URL = `https://${WEBVPN_HOST}/login?cas_login=true`;
const KEY = Buffer.from('wrdvpnisthebest!', 'utf8');

const cache = new Map<string, string>();

export function encryptHost(host: string): string {
  const hit = cache.get(host);
  if (hit) return hit;
  const padded = host + '0'.repeat((16 - (host.length % 16)) % 16);
  const cipher = createCipheriv('aes-128-cfb', KEY, KEY);
  const enc = Buffer.concat([cipher.update(padded, 'utf8'), cipher.final()]);
  const out = KEY.toString('hex') + enc.toString('hex').slice(0, host.length * 2);
  cache.set(host, out);
  return out;
}

export function toWebvpnUrl(url: string): string {
  const u = new URL(url);
  const scheme = u.protocol.replace(':', '');
  const segment = u.port ? `${scheme}-${u.port}` : scheme;
  return `https://${WEBVPN_HOST}/${segment}/${encryptHost(u.hostname)}${u.pathname}${u.search}`;
}

/** WebVPN 会话失效时会被带回它的登录页 */
export function isWebvpnLogin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === WEBVPN_HOST && u.pathname.startsWith('/login');
  } catch {
    return false;
  }
}
