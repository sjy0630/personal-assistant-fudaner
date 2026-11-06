import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface MailMessage {
  /** 邮箱内唯一 ID（INBOX 的 UID） */
  uid: string;
  messageId?: string;
  threadKey?: string;
  from: { name?: string; address: string };
  to: string[];
  subject: string;
  date: string;
  text: string;
}

export interface MailClient {
  fetchSince(since: Date, limit?: number): Promise<MailMessage[]>;
  ping(): Promise<boolean>;
}

export interface ImapConfig {
  /** 学生邮箱 @m.fudan.edu.cn 复旦官方客户端指南使用腾讯企业邮服务器，账号授权需实测 */
  host: string;
  port: number;
  user: string;
  /** 客户端专用密码（不是 UIS 密码） */
  password: string;
}

export const DEFAULT_FUDAN_STUDENT_IMAP = { host: 'imap.exmail.qq.com', port: 993 };

/** IMAP 只读客户端：只读取 INBOX，不标记已读、不删除、不移动。 */
export class ImapMailClient implements MailClient {
  constructor(private readonly config: ImapConfig) {}

  private connect(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });
  }

  async ping(): Promise<boolean> {
    const client = this.connect();
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async fetchSince(since: Date, limit?: number): Promise<MailMessage[]> {
    const client = this.connect();
    const out: MailMessage[] = [];
    try {
      await client.connect();
      // readOnly：以 EXAMINE 打开，保证不改变邮件状态
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const uids = (await client.search({ since }, { uid: true })) || [];
        // 同步默认读取全部命中邮件，避免截断后推进游标造成永久漏信。
        const recent = limit === undefined ? uids : uids.slice(-Math.max(0, Math.floor(limit)));
        if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) return out;
        if (recent.length === 0) return out;
        for (let offset = 0; offset < recent.length; offset += 100) {
          for await (const msg of client.fetch(recent.slice(offset, offset + 100), { uid: true, source: true }, { uid: true })) {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value?.[0];
            const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
            out.push({
              uid: String(msg.uid),
              messageId: parsed.messageId,
              threadKey: (parsed.references && [parsed.references].flat()[0]) || parsed.messageId,
              from: { name: from?.name, address: from?.address ?? '' },
              to: toList.flatMap((t) => t.value.map((v) => v.address ?? '')),
              subject: parsed.subject ?? '(无主题)',
              date: (parsed.date ?? new Date()).toISOString(),
              text: (parsed.text ?? '').slice(0, 8000),
            });
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      const auth = (error as { authenticationFailed?: boolean }).authenticationFailed;
      if (auth || code === 'AUTHENTICATIONFAILED') throw new Error('请检查邮箱地址、客户端专用密码，并确认网页邮箱已开启 IMAP。');
      throw new Error('请检查邮箱服务器、端口和网络连接后重试同步。');
    } finally {
      await client.logout().catch(() => undefined);
    }
    return out;
  }
}
