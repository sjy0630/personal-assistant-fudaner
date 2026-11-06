import { BrowserWindow, session, type Session } from 'electron';
import { NeedLoginError, PLATFORM_URLS, isUisLoginUrl, type FudanAuth, type FudanPlatform, type PlatformStatus } from '@fudaner/fudan-auth';

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
    if (res.status === 401 || isUisLoginUrl(res.url)) {
      this.setStatus(platform, 'need_login');
      throw new NeedLoginError(platform);
    }
    this.setStatus(platform, res.ok ? 'ok' : 'unavailable');
    return res;
  }

  async status(platform: FudanPlatform): Promise<PlatformStatus> {
    const c = this.cache.get(platform);
    if (c && Date.now() - c.at < 5 * 60_000) return c.status;
    return this.probe(platform);
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
      win.on('closed', () => {
        this.loginWindow = null;
        if (verified) {
          void this.activatePlatforms().then(resolve, reject);
        } else {
          this.cache.delete('elearning');
          this.onChanged();
          reject(new Error('请完成复旦账号登录后再同步。'));
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

