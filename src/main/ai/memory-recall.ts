/**
 * 记忆和早先对话的检索。
 *
 * 1. 字面匹配：中文按两字片段、英文按单词算重合度；
 * 2. 同义说法：校园里常见的说法（出国 ↔ 交换 / 留学，保研 ↔ 推免……），问「出国」也能找到「交换」；
 * 3. 语义匹配（可选）：配置了向量模型（如本地 Ollama 的 bge-m3、通义 text-embedding-v3）时，按语义相似度加分。
 *    向量算一次存起来，内容变了才重算；向量服务不可用时自动退回前两种。
 */

/** 同一组里的词意思相近：问到其中一个，检索时其他几个也算 */
export const CONCEPTS: string[][] = [
  ['交换', '留学', '出国', '海外', '访学', '国外', '境外', '暑校'],
  ['保研', '推免', '读研', '考研', '研究生', '直博', '升学'],
  ['绩点', 'GPA', '成绩', '分数', '排名', '给分'],
  ['期末', '考试', '期中', '测验', '小测', '复习'],
  ['作业', 'DDL', '截止', 'Lab', '实验报告', 'ddl'],
  ['实习', '工作', '求职', '秋招', '春招', '面试', '简历', '找工作'],
  ['雅思', '托福', 'GRE', '英语', '四六级', '口语'],
  ['选课', '课程', '学分', '培养方案', '毕业要求'],
  ['竞赛', '比赛', '大赛', '数学建模', '挑战杯'],
  ['科研', '论文', '课题', '实验室', '导师', '组会'],
  ['社团', '学生会', '志愿', '活动'],
  ['健身', '运动', '跑步', '游泳', '体育', '打球'],
  ['焦虑', '压力', '睡不着', '失眠', '心情', '难过', '累'],
  ['食堂', '吃饭', '外卖', '饭'],
  ['宿舍', '电费', '电量', '寝室'],
  ['图书馆', '自习', '占座'],
  ['奖学金', '助学金', '评奖'],
];

/** 几乎每句话都有的两字片段，不算相关 */
const STOP = new Set(['什么', '一下', '我们', '你们', '他们', '这个', '那个', '怎么', '可以', '没有', '就是', '还是', '现在', '时候', '一个',
  '知道', '帮我', '需要', '如何', '哪些', '有没', '不是', '我的', '你的', '我想', '想要', '一些', '这些', '那些', '的话', '然后', '因为', '所以',
  '如果', '但是', '已经', '还有', '是不', '不要', '告诉', '给我', '看看', '有什', '是什', '么时', '下吗', '好的', '谢谢']);

export function grams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) out.add(w);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) {
      const g = run.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return out;
}

/** 问题里出现的概念对应的整组同义说法（不含问题里已有的词） */
export function expandQuery(text: string): string[] {
  const lower = text.toLowerCase();
  return CONCEPTS.filter((group) => group.some((w) => lower.includes(w.toLowerCase())))
    .flat().filter((w) => !lower.includes(w.toLowerCase()));
}

/**
 * 相关度：问题和内容共有的两字片段 / 英文单词各算 1 分；
 * 内容里出现了问题的同义说法（问「出国」，内容说「交换」）每个也算 1 分，但最多 2 分，不让同义词盖过原词。
 */
export function lexicalScore(query: string, content: string): number {
  const q = grams(query);
  const c = grams(content);
  let n = 0;
  for (const x of q) if (c.has(x)) n++;
  const lower = content.toLowerCase();
  const synonyms = expandQuery(query).filter((w) => lower.includes(w.toLowerCase())).length;
  return n + Math.min(2, synonyms);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** 向量模型（可选） */
export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** 向量缓存：按（类别、id、模型）存，内容 hash 变了就重算 */
export interface VectorStore {
  getVectors(kind: string, model: string): Map<string, { hash: string; vector: number[] }>;
  setVector(kind: string, id: string, model: string, hash: string, vector: number[]): void;
}

export function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/**
 * 给候选打分并排序。有向量模型时：字面分 + 语义相似度 × 8；向量失败时只用字面分。
 * 返回 [条目, 分数]，分数越高越相关。
 */
export async function rank<T extends { id: string }>(
  query: string, items: T[], textOf: (x: T) => string,
  opts: { kind: string; embedder?: Embedder | null; store?: VectorStore; boost?: (x: T) => number } ,
): Promise<{ item: T; score: number; semantic?: number }[]> {
  const base = items.map((item) => ({ item, score: lexicalScore(query, textOf(item)) * 2 + (opts.boost?.(item) ?? 0), semantic: undefined as number | undefined }));
  const { embedder, store } = opts;
  if (embedder && store && items.length) {
    try {
      const cached = store.getVectors(opts.kind, embedder.model);
      const missing = items.filter((x) => cached.get(x.id)?.hash !== hashText(textOf(x)));
      for (let i = 0; i < missing.length; i += 32) {
        const batch = missing.slice(i, i + 32);
        const vectors = await embedder.embed(batch.map(textOf));
        batch.forEach((x, j) => { if (vectors[j]) { store.setVector(opts.kind, x.id, embedder.model, hashText(textOf(x)), vectors[j]); cached.set(x.id, { hash: hashText(textOf(x)), vector: vectors[j] }); } });
      }
      const [qv] = await embedder.embed([query]);
      for (const b of base) {
        const v = cached.get(b.item.id)?.vector;
        if (v && qv) { b.semantic = cosine(qv, v); b.score += Math.max(0, b.semantic - 0.3) * 8; }
      }
    } catch (e) {
      console.warn('[Fudaner 记忆] 向量检索失败，改用字面匹配：', (e as Error).message);
    }
  }
  return base.sort((a, b) => b.score - a.score);
}
