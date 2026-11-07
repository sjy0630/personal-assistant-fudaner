/**
 * 学校和院系官网的「通知公告」列表页（公开页面）。
 * 地址来自各网站的公开栏目；部分网站只允许校园网访问，校外需要先连学校 VPN。
 * 网站改版后地址可能失效，同步时会在设置页显示哪个来源读不到。
 */
export interface NoticeSource {
  id: string;
  name: string;
  url: string;
  group: '学校部门' | '院系';
}

const dept = (id: string, name: string, url: string): NoticeSource => ({ id, name, url, group: '学校部门' });
const school = (id: string, name: string, url: string): NoticeSource => ({ id, name, url, group: '院系' });

export const NOTICE_SOURCES: NoticeSource[] = [
  dept('jwc', '教务处', 'https://jwc.fudan.edu.cn/9397/list.htm'),
  dept('gs', '研究生院', 'https://gs.fudan.edu.cn/tzgg/list.htm'),
  dept('fao', '国际合作与交流处', 'https://fao.fudan.edu.cn/15884/list.htm'),
  dept('xianghui', '相辉学堂', 'https://xianghui.fudan.edu.cn/cate/81'),
  dept('cec', '英语教学部', 'https://cec.fudan.edu.cn/23080/list.htm'),
  dept('fdty', '体育教学部', 'https://fdty.fudan.edu.cn/29222/list.htm'),
  dept('bwc', '保卫处', 'https://baoweichu.fudan.edu.cn/6707/list.htm'),
  dept('zwc', '总务处', 'https://zongwuchu.fudan.edu.cn/16531/list.htm'),
  dept('cwc', '财务处', 'https://cwc.fudan.edu.cn/12185/list.htm'),
  dept('ices', '国际文化交流学院', 'https://ices.fudan.edu.cn/6758/list.htm'),
  school('chinese', '中国语言文学系', 'https://chinese.fudan.edu.cn/tzgg/list.htm'),
  school('dfll', '外国语言文学学院', 'https://dfll.fudan.edu.cn/27751/list.htm'),
  school('xwxy', '新闻学院', 'https://xwxy.fudan.edu.cn/ggl/list.htm'),
  school('history', '历史学系', 'https://history.fudan.edu.cn/xwzx/tzgg.htm'),
  school('philosophy', '哲学学院', 'https://philosophy.fudan.edu.cn/tzgg_20877/list.htm'),
  school('sirpa', '国际关系与公共事务学院', 'https://sirpa.fudan.edu.cn/35036/list.htm'),
  school('som', '马克思主义学院', 'https://som.fudan.edu.cn/15048/list.htm'),
  school('law', '法学院', 'https://law.fudan.edu.cn/28093/list.htm'),
  school('econ', '经济学院', 'https://econ.fudan.edu.cn/xwzx/tzgg.htm'),
  school('fisf', '国际金融学院', 'https://fisf.fudan.edu.cn/lists-notice.html'),
  school('tourism', '旅游学系', 'https://tourism.fudan.edu.cn/xwzx/tzgg.htm'),
  school('chm', '文物与博物馆学系', 'https://www.chm.fudan.edu.cn/tzgg/list.htm'),
  school('math', '数学科学学院', 'https://math.fudan.edu.cn/30286/list.htm'),
  school('phys', '物理学系', 'https://phys.fudan.edu.cn/7453/list.htm'),
  school('chemistry', '化学系', 'https://chemistry.fudan.edu.cn/45208/list.htm'),
  school('polymer', '高分子科学系', 'https://polymer.fudan.edu.cn/31394/list.htm'),
  school('imp', '核科学与技术系', 'https://imp.fudan.edu.cn/48897/list.htm'),
  school('life', '生命科学学院', 'https://life.fudan.edu.cn/28139/list.htm'),
  school('environment', '环境科学与工程系', 'https://environment.fudan.edu.cn/26493/list.htm'),
  school('atmsci', '大气与海洋科学系', 'https://atmsci.fudan.edu.cn/annoucement/list.htm'),
  school('sds', '大数据学院', 'https://sds.fudan.edu.cn/zytz/list.htm'),
  school('ai', '计算与智能创新学院', 'https://ai.fudan.edu.cn/24257/list.htm'),
  school('fit', '未来信息创新学院', 'https://fit.fudan.edu.cn/Data/List/event'),
  school('icmne', '集成电路与微纳电子创新学院', 'https://icmne.fudan.edu.cn/tzgg/list.htm'),
  school('bme', '生物医学工程与技术创新学院', 'https://bme-college.fudan.edu.cn/tzgg/list.htm'),
  school('ciram', '智能机器人与先进制造创新学院', 'https://ciram.fudan.edu.cn/tzgg/list.htm'),
  school('icome', '智能材料与未来能源创新学院', 'https://icome.fudan.edu.cn/49262/list.htm'),
  school('basicmed', '基础医学院', 'https://basicmed.fudan.edu.cn/30927/list.htm'),
  school('sph', '公共卫生学院', 'https://sph.fudan.edu.cn/ac/7'),
  school('spfdu', '药学院', 'https://spfdu.fudan.edu.cn/28477/list.htm'),
  school('nursing', '护理学院', 'https://nursing.fudan.edu.cn/tzgg/list.htm'),
  school('sfms', '法医学与法庭科学学院', 'https://sfms.fudan.edu.cn/51779/list.htm'),
];

/** 院系名称的简称和常见写法，用来从用户画像里认出本人院系 */
function aliases(name: string): string[] {
  const short = name.replace(/^(复旦大学)/, '').replace(/(创新学院|学院|学系|系)$/, '');
  return [name, short].filter((s) => s.length >= 2);
}

/** 用户画像里的院系对应的通知来源 */
export function ownSchoolSources(school?: string): NoticeSource[] {
  const text = school?.trim();
  if (!text) return [];
  return NOTICE_SOURCES.filter((s) => s.group === '院系' && aliases(s.name).some((a) => text.includes(a) || a.includes(text)));
}

/** 兴趣和目标里出现这些词时，自动关注对应的部门 */
const INTEREST_SOURCES: { pattern: RegExp; id: string; why: string }[] = [
  { pattern: /交换|留学|出国|海外|访学|暑校|国际项目/, id: 'fao', why: '交换、留学' },
  { pattern: /保研|推免|考研|读研|研究生|硕士|博士/, id: 'gs', why: '读研、推免' },
  { pattern: /英语|雅思|托福|四六级|口语/, id: 'cec', why: '英语' },
  { pattern: /体育|健身|跑步|游泳|球|体测/, id: 'fdty', why: '体育' },
  { pattern: /相辉|荣誉项目|拔尖/, id: 'xianghui', why: '荣誉项目' },
];

/**
 * 用户没有手动选择时，按画像和记忆自动关注：教务处、本人院系、研究生院（研究生），
 * 以及兴趣和目标里提到的方向（交换 → 国际合作与交流处 等）。返回 id 和理由。
 */
export function suggestNoticeSources(profile: { school?: string; degree?: string }, memories: { type: string; content: string }[] = []): { id: string; why: string }[] {
  const out: { id: string; why: string }[] = [{ id: 'jwc', why: '选课、考试、学籍等全校通知' }];
  const add = (id: string, why: string) => { if (!out.some((x) => x.id === id)) out.push({ id, why }); };
  for (const s of ownSchoolSources(profile.school)) add(s.id, '你所在的院系');
  if (profile.degree && /硕士|博士|研究生/.test(profile.degree)) add('gs', '你是研究生');
  const text = memories.filter((m) => m.type === 'interest' || m.type === 'goal').map((m) => m.content).filter((c) => !c.startsWith('不关心')).join(' ');
  for (const rule of INTEREST_SOURCES) if (rule.pattern.test(text)) add(rule.id, `你关心${rule.why}`);
  return out;
}

/** 没有设置过时，默认关注的来源 id */
export function defaultNoticeSources(profile: { school?: string; degree?: string }, memories: { type: string; content: string }[] = []): string[] {
  return suggestNoticeSources(profile, memories).map((s) => s.id);
}

/** 按 id 或名称（可以是简称，如「国交处」「经院」）找来源 */
export function findNoticeSource(query: string): NoticeSource | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const alias: Record<string, string> = { 国交处: 'fao', 国际交流处: 'fao', 研院: 'gs', 经院: 'econ', 计院: 'ai', 计算机: 'ai', 大数据: 'sds', 数院: 'math', 物理: 'phys', 化学: 'chemistry', 新院: 'xwxy', 外院: 'dfll', 中文系: 'chinese', 法院: 'law', 历史: 'history', 哲院: 'philosophy', 国务: 'sirpa', 体育部: 'fdty', 英语部: 'cec', 公卫: 'sph', 药学: 'spfdu', 护理: 'nursing', 基医: 'basicmed', 生科: 'life', 环境: 'environment', 微电子: 'icmne', 集成电路: 'icmne' };
  const id = alias[q] ?? q;
  return NOTICE_SOURCES.find((s) => s.id === id) ?? NOTICE_SOURCES.find((s) => s.name === q)
    ?? ownSchoolSources(q)[0] ?? NOTICE_SOURCES.find((s) => s.name.includes(q) || q.includes(s.name));
}
