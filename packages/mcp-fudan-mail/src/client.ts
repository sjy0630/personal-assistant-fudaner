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
  /** 学生邮箱 @m.fudan.edu.cn 据推断托管于腾讯企业邮，待实测 */
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

  async fetchSince(since: Date, limit = 200): Promise<MailMessage[]> {
    const client = this.connect();
    await client.connect();
    const out: MailMessage[] = [];
    try {
      // readOnly：以 EXAMINE 打开，保证不改变邮件状态
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const uids = (await client.search({ since }, { uid: true })) || [];
        const recent = uids.slice(-limit);
        if (recent.length === 0) return out;
        for await (const msg of client.fetch(recent, { uid: true, source: true }, { uid: true })) {
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
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return out;
  }
}
