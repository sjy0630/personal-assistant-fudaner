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

  /**
   * 不做登录判断的原始请求（同一个登录会话，带 Cookie）。树洞、旦克走 WebVPN 时用。
   * timeoutMs 用于直连探测，连不上时尽快放弃。
   */
  async rawFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<{ status: number; url: string; contentType: string; text: string }> {
    const res = await this.ses.fetch(url, {
      method: init.method ?? 'GET', headers: init.headers, body: init.body, credentials: 'include', redirect: 'follow',
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    } as RequestInit);
    return { status: res.status, url: res.url || url, contentType: res.headers.get('content-type') ?? '', text: await res.text() };
  }

  /** WebVPN 会话是否有效：访问首页不会被带回它的登录页 */
  private async webvpnAlive(): Promise<boolean> {
    try {
      const res = await this.ses.fetch('https://webvpn.fudan.edu.cn/', { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(15_000) } as RequestInit);
      await res.body?.cancel().catch(() => undefined);
      const u = new URL(res.url);
      return res.ok && u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login');
    } catch {
      return false;
    }
  }

  private webvpnLogin: Promise<void> | null = null;

  /**
   * 建立 WebVPN 会话。统一身份认证最后一步靠页面脚本跳回 WebVPN，后台请求走不完，
   * 所以在隐藏窗口里打开 WebVPN 的统一身份认证入口：复旦账号已登录时几秒内自动完成；
   * 学校要求输入密码或二次验证时，把窗口显示出来让用户自己完成。
   */
  ensureWebvpn(): Promise<void> {
    if (this.webvpnLogin) return this.webvpnLogin;
    this.webvpnLogin = (async () => {
      if (await this.webvpnAlive()) return;
      const win = new BrowserWindow({
        show: false, width: 480, height: 720, title: '登录 WebVPN（用于校外访问树洞）', autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      try {
        void win.loadURL('https://webvpn.fudan.edu.cn/login?cas_login=true').catch(() => {});
        const start = Date.now();
        let shownAt = 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, 500));
          if (win.isDestroyed()) throw new NeedLoginError('elearning', '没有完成 WebVPN 登录');
          const url = win.webContents.getURL();
          let host = '';
          let path = '';
          try { ({ hostname: host, pathname: path } = new URL(url)); } catch { /* 还没开始加载 */ }
          if (host === 'webvpn.fudan.edu.cn' && !path.startsWith('/login') && !win.webContents.isLoading() && await this.webvpnAlive()) return;
          // 停在统一身份认证页面：需要用户自己输入密码 / 二次验证
          if (isUisLoginUrl(url) && !shownAt && Date.now() - start > 4000) { win.show(); shownAt = Date.now(); }
          if (Date.now() - start > (shownAt ? 180_000 : 30_000)) throw new NeedLoginError('elearning', 'WebVPN 登录超时，请重新登录复旦账号后再试');
        }
      } finally {
        if (!win.isDestroyed()) win.destroy();
      }
    })().finally(() => { this.webvpnLogin = null; });
    return this.webvpnLogin;
  }

  /** 用登录会话读一个页面的文字（教务系统等）。被带到登录页时抛出 NeedLoginError */
  async getText(platform: FudanPlatform, url: string, init?: RequestInit): Promise<{ url: string; status: number; text: string }> {
    const res = await this.fetch(platform, url, init);
    return { url: res.url || url, status: res.status, text: await res.text() };
  }

  /**
   * 在隐藏窗口里打开页面，等页面脚本渲染完再取 HTML（含同源 iframe）。
   * 用于考试安排、校园卡这类靠脚本加载内容的页面。只读页面内容，不点击、不提交。
   */
  async renderPage(platform: FudanPlatform, url: string, ready: (html: string, url: string) => boolean, timeoutMs = 20_000): Promise<string> {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      void win.loadURL(url).catch(() => {});
      const deadline = Date.now() + timeoutMs;
      let html = '';
      let onUisSince = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (win.isDestroyed()) break;
        // 单点登录会短暂经过统一身份认证页面再跳回来；停在那里超过 5 秒才说明需要重新登录
        if (isUisLoginUrl(win.webContents.getURL())) {
          onUisSince ||= Date.now();
          if (Date.now() - onUisSince > 5000) {
            this.setStatus(platform, 'need_login');
            throw new NeedLoginError(platform);
          }
          continue;
        }
        onUisSince = 0;
        if (win.webContents.isLoading()) continue;
        html = await win.webContents.executeJavaScript(`(() => {
          const parts = [document.documentElement.outerHTML];
          for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) parts.push(f.contentDocument.documentElement.outerHTML); } catch {} }
          return parts.join('\n');
        })()`).catch(() => '') as string;
        if (ready(html, win.webContents.getURL())) return html;
      }
      return html;
    } finally {
      if (!win.isDestroyed()) win.destroy();
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
