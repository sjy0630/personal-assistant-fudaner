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

export async function readElectricity(reader: CampusReader): Promise<DormElectricity> {
  await reader.getText(ZLAPP_SSO);
  const res = await reader.getText(ZLAPP_ELEC);
  // 单点登录没成功时会被带到它自己的登录页
  if (/\/uc\/wap\/login/.test(res.url) || /<html/i.test(res.text.slice(0, 200))) throw new NeedLoginError('jwfw');
  return parseElectricity(res.text);
}
