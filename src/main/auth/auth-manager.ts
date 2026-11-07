import { BrowserWindow, session, type Session } from 'electron';
import { NeedLoginError, PLATFORM_URLS, isPermissionDenied, isUisLoginUrl, type FudanAuth, type FudanPlatform, type PlatformStatus } from '@fudaner/fudan-auth';

const PARTITION = 'persist:fudan';

/**
 * 统一认证层（PRD §7.3）：一次 UIS 登录，所有校内平台共用。
 *
 * - 登录窗口使用独立的持久化会话分区 persist:fudan，用户自己输入账号密码、完成验证码。
 * - 应用不注入脚本、不读取表单、不保存密码；只复用登录后的会话。
 * - 登录成功后，在后台依次「激活」其他平台（访问入口，UIS 自动完成单点登录跳转）。
 *
 * TODO(B)：11/4 实测后确认：登录成功的判定 URL、iCourse 激活入口、校外是否需要 WebVPN。
 */
export class AuthManager implements FudanAuth {
  private readonly ses: Session = session.fromPartition(PARTITION);
  private loginWindow: BrowserWindow | null = null;
  private loginPromise: Promise<void> | null = null;
  private readonly cache = new Map<FudanPlatform, { status: PlatformStatus; at: number }>();

  constructor(private readonly onChanged: () => void = () => {}) {}

  async fetch(platform: FudanPlatform, url: string, init?: RequestInit): Promise<Response> {
    const res = await this.ses.fetch(url, { ...init, credentials: 'include', redirect: 'follow', signal: init?.signal ?? AbortSignal.timeout(20_000) } as RequestInit);
    if (isUisLoginUrl(res.url) || (res.status === 401 && !(await isPermissionDenied(res)))) {
      this.setStatus(platform, 'need_login');
      throw new NeedLoginError(platform);
    }
    // 没有权限（401 unauthorized、403）和找不到（404）只影响这一个接口，说明登录本身是有效的。
    this.setStatus(platform, res.status >= 500 ? 'unavailable' : 'ok');
    return res;
  }

  async status(platform: FudanPlatform): Promise<PlatformStatus> {
    const c = this.cache.get(platform);
    if (c && Date.now() - c.at < 5 * 60_000) return c.status;
    return this.probe(platform);
  }

  /** 最近一次知道的状态，不发请求（对话里用，避免每条消息都等网络） */
  cachedStatus(platform: FudanPlatform): PlatformStatus | undefined {
    return this.cache.get(platform)?.status;
  }

  private async probe(platform: FudanPlatform): Promise<PlatformStatus> {
    try {
      const url = platform === 'elearning' ? `${PLATFORM_URLS.elearning.base}/api/v1/users/self` : PLATFORM_URLS[platform].entry;
      const res = await this.ses.fetch(url, { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(20_000) } as RequestInit);
      let status: PlatformStatus = isUisLoginUrl(res.url) || res.status === 401 ? 'need_login' : res.ok ? 'ok' : 'unavailable';
      if (platform === 'elearning' && status === 'ok') {
        const user = res.headers.get('content-type')?.includes('json') ? await res.json() as { id?: unknown } : null;
        if (!user?.id) status = 'need_login';
      }
      this.setStatus(platform, status);
      return status;
    } catch {
      this.setStatus(platform, 'unavailable');
      return 'unavailable';
    }
  }

  /** 已有会话和新登录都通过身份接口核验，手动关闭窗口不视为登录成功。 */
  requestLogin(): Promise<void> {
    if (this.loginPromise) {
      this.loginWindow?.focus();
      return this.loginPromise;
    }
    const login = new Promise<void>((resolve, reject) => {
      const win = new BrowserWindow({
        width: 480, height: 720, title: '登录复旦统一身份认证', autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      this.loginWindow = win;
      let checking = false;
      let verified = false;
      let loadFailed = false;
      const check = async (url: string) => {
        if (win.isDestroyed() || checking) return;
        try {
          if (new URL(url).origin !== PLATFORM_URLS.elearning.base) return;
        } catch { return; }
        checking = true;
        try {
          verified = await this.probe('elearning') === 'ok';
          if (verified && !win.isDestroyed()) win.close();
        } finally { checking = false; }
      };
      win.webContents.on('did-navigate', (_e, url) => { void check(url); });
      win.webContents.on('did-redirect-navigation', (_e, url) => { void check(url); });
      win.webContents.on('did-finish-load', () => { void check(win.webContents.getURL()); });
      // 打不开学校页面（校外没连 VPN、断网、学校网站故障）时，窗口里说明原因，不留一片空白。
      // -3 是跳转打断了上一次加载，属于正常情况。
      win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
        if (!isMainFrame || code === -3 || win.isDestroyed()) return;
        loadFailed = true;
        void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadFailedPage(url, desc))}`).catch(() => {});
      });
      win.on('closed', () => {
        this.loginWindow = null;
        if (verified) {
          void this.activatePlatforms().then(resolve, reject);
        } else {
          this.cache.delete('elearning');
          this.onChanged();
          reject(new Error(loadFailed
            ? '请检查网络：打不开复旦登录页面。在校外请先连接学校 VPN，再重新登录。'
            : '请完成复旦账号登录后再同步。'));
        }
      });
      void win.loadURL(PLATFORM_URLS.elearning.entry).catch(() => {
        // 导航跳转可能中止 loadURL；保留窗口让用户重试或关闭。
      });
    });
    this.loginPromise = login.finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  /** 用同一会话访问其他平台入口，触发 UIS 单点登录 */
  private async activatePlatforms(): Promise<void> {
    for (const p of ['icourse'] as FudanPlatform[]) {
      try {
        const res = await this.ses.fetch(PLATFORM_URLS[p].entry, { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(20_000) } as RequestInit);
        this.setStatus(p, isUisLoginUrl(res.url) ? 'need_login' : res.ok ? 'ok' : 'unavailable');
      } catch {
        this.setStatus(p, 'unavailable');
      }
    }
  }

  async logout(): Promise<void> {
    await this.ses.clearStorageData();
    this.cache.clear();
    this.onChanged();
  }

  private setStatus(p: FudanPlatform, s: PlatformStatus) {
    const prev = this.cache.get(p)?.status;
    this.cache.set(p, { status: s, at: Date.now() });
    if (prev !== s) this.onChanged();
  }
}


/** 登录窗口打不开学校页面时显示的说明页（纯静态，无脚本） */
function loadFailedPage(url: string, reason: string): string {
  const safe = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const retry = url.startsWith('https://') ? url : PLATFORM_URLS.elearning.entry;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>打不开复旦登录页面</title>
<body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:40px 32px;color:#3b2f2a;background:#fbf7f2;line-height:1.7">
<h2 style="font-weight:600">打不开复旦登录页面</h2>
<p>常见原因：</p>
<ul><li>在校外：先连接学校 VPN，再点下面的「重试」；</li><li>电脑没有联网；</li><li>学校网站暂时故障，稍后再试。</li></ul>
<p><a href="${safe(retry)}" style="display:inline-block;padding:8px 20px;border-radius:8px;background:#b5562f;color:#fff;text-decoration:none">重试</a></p>
<p style="color:#8a7b72;font-size:13px">错误信息：${safe(reason)}</p>
</body></html>`;
}
