import { join } from 'node:path';
import type { ExternalMcpConfig, ExternalMcpPreset } from '../../shared/types';

/**
 * 外部 MCP 服务：同学们在 GitHub 上做好的复旦校园服务，Fudaner 作为宿主接进来，旦旦可以直接调用。
 *
 * 安全约束：
 * - 账号密码由各服务自己保存（它们各自的配置脚本、.env 或系统钥匙串），Fudaner 不读取、不保存；
 * - 只开放只读工具：预设服务按工具名白名单；自定义服务默认只开放标了 readOnlyHint 的工具；
 * - 工具结果当作外部数据交给模型（见 agent.ts），不当作指令。
 */
export interface ExternalPreset {
  preset: Exclude<ExternalMcpPreset, 'custom'>;
  name: string;
  /** 给用户看的说明：能做什么 */
  summary: string;
  repo: string;
  license: string;
  /** 需要用户先做的准备 */
  setup: string[];
  /** 需要填本地文件夹 */
  needsDir: boolean;
  dirHint?: string;
  /** 允许的工具；'annotated' 表示按服务自己标的只读注解 */
  allow: string[] | 'annotated';
  launch(cfg: ExternalMcpConfig, platform: NodeJS.Platform): { command: string; args: string[]; cwd?: string };
}

export const EXTERNAL_PRESETS: ExternalPreset[] = [
  {
    preset: 'fudan-library',
    name: '复旦图书馆文献检索',
    summary: '检索复旦图书馆馆藏文献、读取摘要、全文索引检索。不需要复旦账号。',
    repo: 'https://github.com/LvDAO/fudan-library-mcp',
    license: 'MIT',
    setup: ['安装 uv（https://docs.astral.sh/uv/ ，macOS 可用 Homebrew：brew install uv）。第一次启动会自动下载，稍等片刻。'],
    needsDir: false,
    allow: ['search_literature', 'search_fulltext', 'get_document', 'get_documents', 'library_status'],
    launch: () => ({ command: 'uvx', args: ['--from', 'git+https://github.com/LvDAO/fudan-library-mcp.git@v0.1.1', 'fudan-library-mcp'] }),
  },
  {
    preset: 'danta',
    name: '旦挞：树洞与旦克课程评价',
    summary: '搜索复旦树洞的帖子和回复、查旦克上的课程评价（给分、难度、老师口碑）。校外通过 WebVPN 访问。',
    repo: 'https://github.com/likangxian1007/danta-mcp',
    license: 'GPL-3.0',
    setup: [
      '克隆仓库并安装依赖：git clone https://github.com/likangxian1007/danta-mcp.git，然后在目录里 python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
      '运行 .venv/bin/python setup_credentials.py 保存账号（复旦 UIS 和树洞账号由它保存在系统钥匙串，Fudaner 不经手）',
      '在下面填写 danta-mcp 文件夹的完整路径',
    ],
    needsDir: true,
    dirHint: '/Users/你的用户名/danta-mcp',
    // 只开放检索类工具；build_citation_report 会在本机写文件、打开浏览器，不开放
    allow: ['search_holes', 'get_hole', 'browse_by_tag', 'list_hot_tags', 'browse_division', 'list_divisions', 'search_courses', 'get_course_reviews', 'check_connection'],
    launch: (cfg, platform) => {
      const dir = cfg.dir ?? '';
      const python = platform === 'win32' ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python');
      return { command: python, args: ['-E', join(dir, 'run_server.py')], cwd: dir };
    },
  },
  {
    preset: 'ehall',
    name: 'ehall：宿舍电量与场馆空闲',
    summary: '查宿舍剩余电量和用电记录、体育场馆和台球室的空闲时段。预约、取消等写操作在 Fudaner 里禁用。',
    repo: 'https://github.com/H4S2O8/ehall',
    license: '未声明开源协议（只在本机运行，不随 Fudaner 分发）',
    setup: [
      '克隆仓库并安装：git clone https://github.com/H4S2O8/ehall.git，然后在目录里 uv sync --extra mcp',
      '按它的说明复制 .env.example 为 .env 并填写（账号保存在它自己的目录里，Fudaner 不读取）',
      '在下面填写 ehall 文件夹的完整路径',
    ],
    needsDir: true,
    dirHint: '/Users/你的用户名/ehall',
    allow: ['electricity_get_remaining', 'electricity_get_records', 'electricity_get_recharge_history', 'sports_list_venues', 'sports_get_schedule', 'sports_get_availability', 'billiards_get_availability', 'card_get_info'],
    launch: (cfg) => ({ command: 'uv', args: ['run', '--extra', 'mcp', 'python', '-m', 'mcp_server.server'], cwd: cfg.dir }),
  },
];

export function presetOf(cfg: Pick<ExternalMcpConfig, 'preset'>): ExternalPreset | undefined {
  return EXTERNAL_PRESETS.find((p) => p.preset === cfg.preset);
}

/** MCP 服务在智能体里的名字：ext-<id> */
export function externalServerName(cfg: Pick<ExternalMcpConfig, 'id'>): string {
  return `ext-${cfg.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 24)}`;
}

/** 启动参数；配置不完整时抛出给用户看的说明 */
export function launchOf(cfg: ExternalMcpConfig, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; cwd?: string } {
  const preset = presetOf(cfg);
  if (preset) {
    if (preset.needsDir && !cfg.dir?.trim()) throw new Error(`请先填写 ${preset.name} 的文件夹路径。`);
    return preset.launch({ ...cfg, dir: cfg.dir?.trim() }, platform);
  }
  if (!cfg.command?.trim()) throw new Error('请填写启动命令。');
  return { command: cfg.command.trim(), args: cfg.args ?? [], cwd: cfg.cwd?.trim() || undefined };
}

/** 工具是否开放给旦旦 */
export function toolAllowed(cfg: ExternalMcpConfig, tool: { name: string; annotations?: { readOnlyHint?: boolean } }): boolean {
  const preset = presetOf(cfg);
  const allow = preset?.allow ?? 'annotated';
  if (Array.isArray(allow)) return allow.includes(tool.name);
  return cfg.allowAllTools === true || tool.annotations?.readOnlyHint === true;
}

/**
 * 桌面应用从 Dock / 开始菜单启动时拿不到终端里的 PATH，
 * 补上 uv、Homebrew、pipx 等常见的安装位置。
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env, home = base.HOME ?? base.USERPROFILE ?? ''): Record<string, string> {
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = process.platform === 'win32'
    ? [join(home, '.local', 'bin'), join(home, '.cargo', 'bin')]
    : [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const path = [...(base.PATH ?? '').split(sep).filter(Boolean), ...extra].filter((p, i, a) => a.indexOf(p) === i).join(sep);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
  // 不把模型 API Key 之类的应用内部变量传给外部程序
  for (const k of Object.keys(env)) if (/^(FUDANER_|ELECTRON_|OPENAI_|ANTHROPIC_|DEEPSEEK_)/.test(k)) delete env[k];
  env.PATH = path;
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

/** 渲染进程传来的外部服务配置：只保留认识的字段，id 规范化、去重 */
export function sanitizeExternal(input: unknown): ExternalMcpConfig[] {
  if (!Array.isArray(input)) throw new Error('请检查扩展服务配置。');
  const out: ExternalMcpConfig[] = [];
  for (const raw of input.slice(0, 20)) {
    const c = raw as Partial<ExternalMcpConfig>;
    const preset = (['fudan-library', 'danta', 'ehall', 'custom'] as const).find((p) => p === c.preset);
    const id = String(c.id ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24);
    if (!preset || !id || out.some((x) => x.id === id)) continue;
    const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    out.push({
      id, preset, name: text(c.name, 60) ?? id, enabled: c.enabled === true,
      dir: text(c.dir), command: preset === 'custom' ? text(c.command) : undefined,
      args: preset === 'custom' && Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string').slice(0, 30) : undefined,
      cwd: preset === 'custom' ? text(c.cwd) : undefined,
      allowAllTools: preset === 'custom' ? c.allowAllTools === true : undefined,
    });
  }
  return out;
}
