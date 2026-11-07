/**
 * 复旦 UIS 统一认证接口（PRD §7.3）。
 *
 * 所有需要登录的校内平台连接器只依赖这个接口，不关心登录细节。
 * - 桌面端：由 Electron 的 AuthManager 实现（内嵌登录窗口 + 共享会话分区 persist:fudan）。
 * - 以后独立运行的 MCP 服务：可以由独立的小登录工具，或借用桌面端登录状态的实现提供。
 *
 * 安全约束：实现方不得读取或保存 UIS 密码；验证码、二次验证由用户本人完成。
 */

export type FudanPlatform = 'elearning' | 'icourse' | 'jwfw';

export type PlatformStatus = 'ok' | 'need_login' | 'unavailable';

export interface FudanAuth {
  /** 用共享的 UIS 会话发请求。会话失效时抛出 NeedLoginError。 */
  fetch(platform: FudanPlatform, url: string, init?: RequestInit): Promise<Response>;
  /** 查询某个平台当前的连接状态。 */
  status(platform: FudanPlatform): Promise<PlatformStatus>;
  /** 请求用户重新登录（桌面端会弹出登录窗口）。 */
  requestLogin(): Promise<void>;
}

export class NeedLoginError extends Error {
  constructor(public readonly platform: FudanPlatform, message = '复旦账号登录已过期，需要重新登录') {
    super(message);
    this.name = 'NeedLoginError';
  }
}

/** 各平台入口地址。具体路径待 11/4 实测后修正。 */
export const PLATFORM_URLS: Record<FudanPlatform, { base: string; entry: string }> = {
  elearning: { base: 'https://elearning.fudan.edu.cn', entry: 'https://elearning.fudan.edu.cn/' },
  icourse: { base: 'https://icourse.fudan.edu.cn', entry: 'https://icourse.fudan.edu.cn/' },
  jwfw: { base: 'https://fdjwgl.fudan.edu.cn', entry: 'https://fdjwgl.fudan.edu.cn/' },
};

/** UIS 登录页所在的主机名（用于判断是否被重定向到了登录页）。 */
export const UIS_HOSTS = ['id.fudan.edu.cn', 'uis.fudan.edu.cn'];

/**
 * eLearning（Canvas）对「已登录但没有权限」也返回 401，例如课程花名册、单元不对学生开放。
 * 两种 401 靠响应体区分：没有权限是 {"status":"unauthorized"}，未登录是 {"status":"unauthenticated"}。
 * 没有权限不代表登录过期，不能让用户重新登录。
 */
export async function isPermissionDenied(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const body = await res.clone().json() as { status?: unknown; errors?: { message?: unknown }[] };
    if (body?.status === 'unauthorized') return true;
    if (body?.status === 'unauthenticated') return false;
    return (body?.errors ?? []).some((e) => typeof e?.message === 'string' && /not authorized to perform/i.test(e.message));
  } catch {
    return false;
  }
}

export function isUisLoginUrl(url: string): boolean {
  try {
    return UIS_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
