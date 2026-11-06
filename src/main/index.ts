import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, safeStorage, shell } from 'electron';
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
      const enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(p).toString('base64') : null;
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

app.whenReady().then(async () => {
  const demoElearning = new DemoElearningClient();
  const demoMail = new DemoMailClient();
  let ctx!: AppContext;
  const auth = new AuthManager(() => send('platforms:changed'));
  const sec = () => secrets(ctx);

  ctx = new AppContext({
    dbPath: join(app.getPath('userData'), 'fudaner.sqlite'),
    channels,
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

  registerIpc(ctx, { auth, window: () => win, demo: { elearning: demoElearning, mail: demoMail }, secrets: sec(), restartScheduler });
  createWindow();
  createTray(ctx, () => { paused = Date.now() + 3_600_000; });
  restartScheduler();
  void ctx.syncAll().then(() => ctx.engine.tick());

  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; void ctx.close(); });
});

app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
