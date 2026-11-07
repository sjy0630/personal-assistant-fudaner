import type { CampusReader } from './timetable-sync';
import { NeedLoginError } from '@fudaner/fudan-auth';

/**
 * 宿舍电量（zlapp.fudan.edu.cn，只读）。先访问它的单点登录入口，用复旦统一身份认证换到会话，再读电量。
 * 返回格式：{ e: 0, d: { xq 校区, ssmc 楼, fjmc 房间, fj_surplus 剩余电量, fj_used 已用, fj_all 总量, fj_update_time 更新时间 } }
 */
export const ZLAPP_SSO = 'https://zlapp.fudan.edu.cn/a_fudanzlapp/api/sso/index?sso=1';
export const ZLAPP_ELEC = 'https://zlapp.fudan.edu.cn/fudanelec/wap/default/info';

export interface DormElectricity { room: string; remainingKwh: number; usedKwh?: number; totalKwh?: number; updatedAt?: string }

export function parseElectricity(body: string): DormElectricity {
  let data: { e?: unknown; m?: string; d?: Record<string, unknown> };
  try { data = JSON.parse(body); } catch { throw new Error('电量系统返回的格式和预期不同。'); }
  if (Number(data.e) !== 0 || !data.d) throw new Error(data.m ? `电量系统：${data.m}` : '电量系统没有返回宿舍信息（可能没有绑定宿舍）。');
  const d = data.d;
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
  const remaining = num(d.fj_surplus);
  if (remaining === undefined || !Number.isFinite(remaining)) throw new Error('电量系统没有返回剩余电量。');
  return {
    room: [d.xq, d.ssmc, d.fjmc].filter((x) => x !== null && x !== undefined && x !== '').join(' '),
    remainingKwh: remaining, usedKwh: num(d.fj_used), totalKwh: num(d.fj_all),
    updatedAt: typeof d.fj_update_time === 'string' ? d.fj_update_time : undefined,
  };
}

/**
 * 先用后台请求走单点登录；统一身份认证最后一步靠页面脚本跳回，后台请求走不完时，
 * 在隐藏窗口里打开单点登录入口（脚本会执行），拿到电量系统的会话后再读。
 */
export async function readElectricity(reader: CampusReader): Promise<DormElectricity> {
  const notLoggedIn = (r: { url: string; text: string }) => /\/uc\/wap\/login/.test(r.url) || /<html/i.test(r.text.slice(0, 300));
  await reader.getText(ZLAPP_SSO).catch(() => undefined);
  let res = await reader.getText(ZLAPP_ELEC);
  if (notLoggedIn(res) && reader.render) {
    await reader.render(ZLAPP_SSO, (_html, url) => {
      try {
        const u = new URL(url);
        return u.hostname === 'zlapp.fudan.edu.cn' && !u.pathname.includes('/uc/wap/login') && !u.pathname.includes('/sso/');
      } catch { return false; }
    });
    res = await reader.getText(ZLAPP_ELEC);
  }
  // 还是被带到它自己的登录页：复旦账号登录过期
  if (notLoggedIn(res)) throw new NeedLoginError('jwfw');
  return parseElectricity(res.text);
}
