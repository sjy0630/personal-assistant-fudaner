import type { FeedSource } from '../../shared/types';
import type { FetchText } from '../activities/sync';
import type { NoticeSource } from '../notices/sources';

/**
 * 演示模式的校园活动：虚构的公众号文章和订阅源，内容和机构均为虚构，不对应真实活动。
 * 日期相对于当前时间生成，演示时总有「接下来几天」的活动。
 */
const FEED_URL = 'https://fudaner-demo.example/activities.xml';
export const demoFeeds: FeedSource[] = [{ url: FEED_URL, name: '演示 · 校园活动汇总' }];

/** 演示用公众号文章链接（对话里可以发给旦旦导入） */
export const DEMO_ARTICLE_URL = 'https://mp.weixin.qq.com/s/fudaner-demo-ai-lecture';

function day(offset: number, now = new Date()): { md: string; wd: string } {
  const d = new Date(now.getTime() + 8 * 3_600_000 + offset * 86_400_000);
  return {
    md: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
    wd: `周${'日一二三四五六'[d.getUTCDay()]}`,
  };
}

function wechatPage(o: { title: string; account: string; body: string[] }): string {
  return `<!doctype html><html><head><meta property="og:title" content="${o.title}"></head><body>
<h1 id="activity-name">${o.title}</h1><a id="js_name">${o.account}</a>
<script>var nickname = htmlDecode("${o.account}"); var ct = "${Math.floor(Date.now() / 1000) - 3600}";</script>
<div class="rich_media_content" id="js_content">${o.body.map((p) => `<p>${p}</p>`).join('')}</div>
</body></html>`;
}

function pages(now = new Date()): Record<string, string> {
  const ai = day(3, now);
  const exchange = day(5, now);
  return {
    [DEMO_ARTICLE_URL]: wechatPage({
      title: '讲座预告｜大模型如何帮助科学发现（演示）', account: '演示 · 计算与智能学院',
      body: [
        '本期青年学者讲座邀请一位虚构的研究者，分享大语言模型在材料与生命科学中的应用。',
        `时间：${ai.md}（${ai.wd}）14:00-16:00`,
        '地点：邯郸校区光华楼东主楼 1801',
        '主讲人：林知远（虚构人物）',
        '主办：演示 · 计算与智能学院',
        '报名方式：无需报名，欢迎对 AI 感兴趣的同学参加。',
      ],
    }),
    'https://fudaner-demo.example/exchange-2027': wechatPage({
      title: '2027 春季交换项目说明会（演示）', account: '演示 · 国际交流处',
      body: [
        '介绍 2027 年春季学期各交换项目的申请条件、材料与时间安排，并有往届同学分享经验。',
        `时间：${exchange.md}（${exchange.wd}）18:30`,
        '地点：线上（腾讯会议，会议号见报名后通知）',
        '报名：填写报名问卷，名额 200 人',
      ],
    }),
  };
}

function feedXml(now = new Date()): string {
  const career = day(2, now);
  const concert = day(4, now);
  const item = (o: { id: string; title: string; link: string; html?: string }) => `<item><title>${o.title}</title><link>${o.link}</link><guid>${o.id}</guid>
<pubDate>${new Date(now.getTime() - 2 * 3_600_000).toUTCString()}</pubDate>${o.html ? `<description><![CDATA[${o.html}]]></description>` : ''}</item>`;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>演示 · 校园活动汇总</title>
${item({ id: 'demo-ai', title: '讲座预告｜大模型如何帮助科学发现（演示）', link: DEMO_ARTICLE_URL })}
${item({ id: 'demo-exchange', title: '2027 春季交换项目说明会（演示）', link: 'https://fudaner-demo.example/exchange-2027' })}
${item({
    id: 'demo-career', title: '演示科技公司 2027 校园招聘宣讲会', link: 'https://fudaner-demo.example/career',
    html: `<p>演示科技公司（虚构）来校宣讲，介绍算法、产品与设计岗位，现场可投递简历。宣讲结束后有简历诊断环节，欢迎各专业同学参加，提前十分钟入场。</p><p>时间：${career.md}（${career.wd}）19:00-21:00</p><p>地点：邯郸校区第三教学楼 3108</p><p>主办：演示 · 学生职业发展中心</p><p>报名：无需报名，现场签到即可。宣讲会提供简单茶点，名额有限先到先得。</p>`,
  })}
${item({
    id: 'demo-concert', title: '秋日合唱音乐会（演示）', link: 'https://fudaner-demo.example/concert',
    html: `<p>学生合唱团（虚构）秋季专场音乐会，曲目包括中外经典合唱作品与原创校园歌曲，全程约九十分钟。凭学生证免费入场，座位有限，建议提前二十分钟到场。</p><p>时间：${concert.md}（${concert.wd}）19:00</p><p>地点：邯郸校区相辉堂</p><p>主办：演示 · 学生艺术团</p><p>报名：在活动小程序预约座位，预约截止到演出前一天中午。</p>`,
  })}
</channel></rss>`;
}

/** 演示用的学校和院系官网通知（虚构） */
export const demoNoticeSources: NoticeSource[] = [
  { id: 'demo-jwc', name: '教务处（演示）', url: 'https://fudaner-demo.example/jwc/list.htm', group: '学校部门' },
  { id: 'demo-school', name: '计算与智能创新学院（演示）', url: 'https://fudaner-demo.example/school/list.htm', group: '院系' },
];

function noticePages(now = new Date()): Record<string, string> {
  const date = (offset: number) => new Date(now.getTime() + 8 * 3_600_000 - offset * 86_400_000).toISOString().slice(0, 10);
  const list = (base: string, rows: [string, string, number][]) => `<html><body><div class="col_news_list"><ul class="news_list">${rows
    .map(([id, title, d]) => `<li class="news"><span class="news_title"><a href="${base}/${id}.htm" title="${title}">${title}</a></span><span class="news_meta">${date(d)}</span></li>`).join('')}</ul></div></body></html>`;
  const detail = (title: string, body: string[]) => `<html><body><h1 class="arti_title">${title}</h1><p class="arti_metas">发布时间：${date(0)}</p><div class="wp_articlecontent">${body.map((p) => `<p>${p}</p>`).join('')}</div></body></html>`;
  const lecture = day(6, now);
  return {
    'https://fudaner-demo.example/jwc/list.htm': list('https://fudaner-demo.example/jwc', [
      ['exam', '关于本学期本科课程期末考试安排的通知（演示）', 0],
      ['library', '图书馆部分区域设备维护的通知（演示）', 1],
    ]),
    'https://fudaner-demo.example/jwc/exam.htm': detail('关于本学期本科课程期末考试安排的通知（演示）', ['各位同学：本学期期末考试安排已发布，请于第 16 周前登录教务系统查看本人考试时间和地点，如有冲突请在规定时间内申请调整。']),
    'https://fudaner-demo.example/jwc/library.htm': detail('图书馆部分区域设备维护的通知（演示）', ['因设备维护，部分阅览区域本周末暂停开放，给大家带来不便敬请谅解。']),
    'https://fudaner-demo.example/school/list.htm': list('https://fudaner-demo.example/school', [
      ['talk', '学术讲座：多模态大模型的前沿进展（演示）', 0],
      ['award', '关于开展本年度学院奖学金评选的通知（演示）', 2],
    ]),
    'https://fudaner-demo.example/school/talk.htm': detail('学术讲座：多模态大模型的前沿进展（演示）', [
      '本次讲座介绍多模态大模型在视觉理解与生成方面的最新进展（主讲人为虚构人物）。',
      `时间：${lecture.md}（${lecture.wd}）15:00-17:00`, '地点：江湾校区交叉学科楼 2001', '主讲人：周明远（虚构）', '欢迎对 AI 感兴趣的同学参加。',
    ]),
    'https://fudaner-demo.example/school/award.htm': detail('关于开展本年度学院奖学金评选的通知（演示）', ['请符合条件的同学于下周五前提交申请材料。']),
  };
}

/** 演示模式下的「网络」：只返回虚构页面 */
export const demoFetchText: FetchText = async (url) => {
  const now = new Date();
  if (url === FEED_URL) return { url, status: 200, text: feedXml(now) };
  const page = pages(now)[url] ?? noticePages(now)[url];
  if (page) return { url, status: 200, text: page };
  throw new Error('演示模式下只能导入演示文章。关掉演示模式后，可以导入真实的公众号文章链接。');
};
