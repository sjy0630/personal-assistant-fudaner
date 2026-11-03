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
  private readonly cache = new Map<FudanPlatform, { status: PlatformStatus; at: number }>();

  constructor(private readonly onChanged: () => void = () => {}) {}

  async fetch(platform: FudanPlatform, url: string, init?: RequestInit): Promise<Response> {
    const res = await this.ses.fetch(url, { ...init, redirect: 'follow' } as RequestInit);
    if (isUisLoginUrl(res.url)) {
      this.setStatus(platform, 'need_login');
      throw new NeedLoginError(platform);
    }
    if (res.ok) this.setStatus(platform, 'ok');
    return res;
  }

  async status(platform: FudanPlatform): Promise<PlatformStatus> {
    const c = this.cache.get(platform);
    if (c && Date.now() - c.at < 5 * 60_000) return c.status;
    try {
      const probe = platform === 'elearning' ? `${PLATFORM_URLS.elearning.base}/api/v1/users/self` : PLATFORM_URLS[platform].entry;
      const res = await this.ses.fetch(probe, { redirect: 'follow' } as RequestInit);
      const s: PlatformStatus = isUisLoginUrl(res.url) || res.status === 401 ? 'need_login' : res.ok ? 'ok' : 'unavailable';
      this.setStatus(platform, s);
      return s;
    } catch {
      this.setStatus(platform, 'unavailable');
      return 'unavailable';
    }
  }

  /** 弹出登录窗口；登录成功（离开 UIS 页面、回到 eLearning）后关闭并激活其他平台 */
  requestLogin(): Promise<void> {
    if (this.loginWindow) {
      this.loginWindow.focus();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 480, height: 720, title: '登录复旦统一身份认证', autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      this.loginWindow = win;
      let sawUis = false;
      const check = (url: string) => {
        if (isUisLoginUrl(url)) { sawUis = true; return; }
        if (sawUis && url.startsWith(PLATFORM_URLS.elearning.base)) {
          this.setStatus('elearning', 'ok');
          win.close();
        }
      };
      win.webContents.on('did-navigate', (_e, url) => check(url));
      win.webContents.on('did-redirect-navigation', (_e, url) => check(url));
      win.on('closed', async () => {
        this.loginWindow = null;
        await this.activatePlatforms();
        resolve();
      });
      void win.loadURL(PLATFORM_URLS.elearning.entry);
    });
  }

  /** 用同一会话访问其他平台入口，触发 UIS 单点登录 */
  private async activatePlatforms(): Promise<void> {
    for (const p of ['icourse'] as FudanPlatform[]) {
      try {
        const res = await this.ses.fetch(PLATFORM_URLS[p].entry, { redirect: 'follow' } as RequestInit);
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

