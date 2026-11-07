import { app, BrowserWindow, Menu, Notification, Tray, clipboard, nativeImage, net, safeStorage, shell, dialog } from 'electron';
import { join } from 'node:path';
import { DEFAULT_FUDAN_STUDENT_IMAP, ImapMailClient } from '@fudaner/mcp-fudan-mail';
import { CanvasClient } from '@fudaner/mcp-fudan-elearning';
import { AppContext } from './app-context';
import { AuthManager } from './auth/auth-manager';
import { DemoElearningClient, DemoMailClient, seedDemoProfile } from './demo/demo';
import type { Channels } from './engine/channels';
import { registerIpc } from './ipc';
// electron-vite 的 ?asset：开发时指向 resources/，打包后指向 app.asar.unpacked/resources/
import iconPath from '../../resources/icon.png?asset&asarUnpack';

/**
 * Electron 主进程入口：窗口、托盘、通知、定时调度。
 * 业务逻辑都在 AppContext 里，这里只负责和操作系统打交道。
 */
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pendingNotificationMessage: string | null = null;

const send = (channel: string, payload?: unknown) => win?.webContents.send('fudaner:event', channel, payload);
function flushNotificationNavigation() {
  if (!pendingNotificationMessage || !win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return;
  send('navigate', { page: 'chat', id: pendingNotificationMessage });
  pendingNotificationMessage = null;
}

const channels: Channels = {
  delta: (run) => send('chat:delta', run),
  messagePosted: (msg) => send('chat:message', msg),
  notify: (title, body, messageId) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { pendingNotificationMessage = messageId; showWindow(); flushNotificationNavigation(); });
    n.show();
  },
  changed: (what) => send(`${what}:changed`),
  toolProgress: (messageId, call) => send('chat:tool', { messageId, call }),
  thinking: (on) => send('chat:thinking', on),
};

// 邮箱客户端专用密码：用 safeStorage 加密后存在本地
const secretsKey = 'mail_password_enc';
function secrets(ctx: AppContext) {
  return {
    setMailPassword(p: string) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('请先解锁系统钥匙串，再保存邮箱客户端专用密码。');
      const enc = safeStorage.encryptString(p).toString('base64');
      ctx.repo.setKv(secretsKey, enc);
    },
    getMailPassword(): string | null {
      const enc = ctx.repo.getKv<string | null>(secretsKey, null);
      return enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : null;
    },
    hasMailPassword(): boolean { return !!ctx.repo.getKv<string | null>(secretsKey, null); },
  };
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600, title: 'Fudaner', show: false, autoHideMenuBar: true, icon: iconPath,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false },
  });
  win.on('ready-to-show', () => win?.show());
  // 排查白屏用：界面进程崩溃、页面加载失败、界面里的报错，都打印到运行 npm run dev 的终端
  win.webContents.on('render-process-gone', (_e, d) => console.error(`[Fudaner] 界面进程退出：${d.reason}（退出码 ${d.exitCode}）`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[Fudaner] 页面加载失败：${desc}（${code}）${url}`));
  win.webContents.on('console-message', (e) => {
    const m = e as unknown as { level?: string; message?: string; sourceId?: string; lineNumber?: number };
    if (m.level === 'error') console.error(`[Fudaner 界面] ${m.message}${m.sourceId ? `（${m.sourceId}:${m.lineNumber}）` : ''}`);
  });
  // did-finish-load 触发时 isLoadingMainFrame 仍可能为 true，等加载状态结束再送达。
  win.webContents.on('did-stop-loading', flushNotificationNavigation);
  // 关闭窗口时最小化到托盘，后台继续同步和提醒
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function createTray(ctx: AppContext, pause: () => void) {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('Fudaner');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `打开${ctx.repo.getProfile().assistantName}`, click: showWindow },
    { label: '暂停提醒 1 小时', click: pause },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// 只允许运行一个实例：关窗口后应用还在托盘里运行，再启动一次会和它同时打开同一个数据库。
// 第二次启动直接把已有窗口调出来，然后退出。
if (!app.requestSingleInstanceLock()) {
  console.log('[Fudaner] 已经有一个 Fudaner 在运行（可能在托盘里），已切换到那个窗口。如果它显示不正常，请先在托盘图标菜单里选「退出」，再重新启动。');
  app.exit(0);
}
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  const demoElearning = new DemoElearningClient();
  const demoMail = new DemoMailClient();
  let ctx!: AppContext;
  const auth = new AuthManager(() => send('platforms:changed'));
  const sec = () => secrets(ctx);

  ctx = new AppContext({
    dbPath: join(app.getPath('userData'), 'fudaner.sqlite'),
    channels,
    fetchText: readPublicPage,
    platformStatus: async (probe) => {
      const s = ctx.repo.getSettings();
      if (s.demoMode) return (['elearning', 'icourse', 'mail'] as const).map((platform) => ({ platform, status: 'demo' as const }));
      const elearning = probe ? await auth.status('elearning') : auth.cachedStatus('elearning');
      return [
        elearning ? { platform: 'elearning', status: elearning } : { platform: 'elearning', status: 'unavailable', message: '本次启动后还没检查过' },
        { platform: 'icourse', status: 'unavailable', message: 'iCourse 尚未接入，课程回放暂不参与同步。' },
        { platform: 'mail', status: s.mail?.user && sec().hasMailPassword() ? 'ok' : 'not_configured' },
      ];
    },
    elearning: () => (ctx.repo.getSettings().demoMode ? demoElearning : new CanvasClient(auth)),
    mail: () => {
      const s = ctx.repo.getSettings();
      if (s.demoMode) return demoMail;
      const pw = sec().getMailPassword();
      if (!s.mail?.user || !pw) return null;
      return new ImapMailClient({ host: s.mail.host || DEFAULT_FUDAN_STUDENT_IMAP.host, port: s.mail.port || DEFAULT_FUDAN_STUDENT_IMAP.port, user: s.mail.user, password: pw });
    },
  });
  if (process.env.FUDANER_DEMO === '1' && !ctx.repo.getSettings().demoMode) ctx.repo.setSettings({ demoMode: true });
  if (ctx.repo.getSettings().demoMode) seedDemoProfile(ctx.repo);
  await ctx.start();

  // 调度：引擎每 10 秒处理一次事件；平台每 30 分钟同步一次（加随机抖动，PRD §9）
  let paused = 0;
  let engineTimer: NodeJS.Timeout | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  const scheduleSync = () => {
    clearTimeout(syncTimer);
    const jitter = Math.random() * 5 * 60_000;
    syncTimer = setTimeout(async () => { await ctx.syncAll().catch(() => undefined); scheduleSync(); }, 30 * 60_000 + jitter);
  };
  const restartScheduler = () => {
    clearInterval(engineTimer);
    engineTimer = setInterval(async () => {
      if (Date.now() < paused) return;
      await ctx.engine.tick().catch((e) => console.error('[engine]', e));
      await ctx.executor.runNext().catch((e) => console.error('[executor]', e));
    }, 10_000);
    scheduleSync();
  };

  registerIpc(ctx, { auth, window: () => win, demo: { elearning: demoElearning, mail: demoMail }, secrets: sec(), restartScheduler,
    openExternal: (url) => shell.openExternal(url), onMessageUpdated: (msg) => send('chat:updated', msg),
    copyText: (text) => clipboard.writeText(text), onChatCleared: () => send('chat:cleared'), onChanged: channels.changed,
  });
  createWindow();
  createTray(ctx, () => { paused = Date.now() + 3_600_000; });
  restartScheduler();
  void ctx.syncAll().then(() => ctx.engine.tick());

  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; void ctx.close(); });
}).catch((error: unknown) => {
  // 启动失败（数据库打不开、端口被占等）时给出明确提示，而不是只留一个白窗口或什么都不显示
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error('[Fudaner] 启动失败：', detail);
  dialog.showErrorBox('Fudaner 启动失败', `${detail}\n\n如果提示数据库被占用，请先在托盘图标菜单里选「退出」旧的 Fudaner，再重新启动。`);
  app.exit(1);
});

app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });

/**
 * 读取公开网页（公众号文章、订阅源）。用 Electron 的网络栈，跟随系统代理；
 * 不带复旦登录会话（默认会话），限时 20 秒、最多 5 MB。
 */
async function readPublicPage(url: string): Promise<{ url: string; status: number; text: string }> {
  const res = await net.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > 5 * 1024 * 1024) throw new Error('页面太大，无法读取。');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > 5 * 1024 * 1024) throw new Error('页面太大，无法读取。');
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(buf.slice(0, 2048)))?.[1]
    ?? 'utf-8';
  let text: string;
  try { text = new TextDecoder(charset).decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); }
  return { url: res.url || url, status: res.status, text };
}
