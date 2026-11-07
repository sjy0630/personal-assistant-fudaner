import { describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { DemoElearningClient, DemoMailClient } from '../src/main/demo/demo';
import { syncElearning } from '../src/main/sources/elearning-sync';
import { syncMail } from '../src/main/sources/mail-sync';
const now = new Date('2026-11-06T10:00:00+08:00');
const channels = { messagePosted() {}, notify() {}, changed() {}, toolProgress() {}, thinking() {} };
const context = () => new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail: () => null });
describe('平台同步恢复', () => {
  it('公告接口中途失败不写入部分课程，下次同步可完整恢复', async () => {
    const ctx = context(); const el = new DemoElearningClient(() => now);
    const list = vi.spyOn(el, 'listAnnouncements').mockRejectedValueOnce(new Error('offline'));
    try {
      await expect(syncElearning(el, ctx.repo, now)).rejects.toThrow('offline');
      expect(ctx.repo.listCourses()).toHaveLength(0);
      expect(ctx.repo.getKv('elearning_last_sync', null)).toBeNull();
      list.mockRestore(); await syncElearning(el, ctx.repo, now);
      expect(ctx.repo.listCourses().length).toBeGreaterThan(0);
    } finally { await ctx.close(); }
  });
  it('重复邮件保留本地处理状态和课程关联，事件不重复', async () => {
    const ctx = context(); const el = new DemoElearningClient(() => now); const mail = new DemoMailClient(() => now);
    try {
      await syncElearning(el, ctx.repo, now); await syncMail(mail, ctx.repo, ctx.router, now);
      const item = ctx.repo.listItems({ kind: 'email' })[0]; const course = ctx.repo.listCourses()[0];
      ctx.repo.upsertItem({ ...item, done: true, courseId: course.id });
      const result = await syncMail(mail, ctx.repo, ctx.router, now);
      expect(ctx.repo.getItem(item.id)).toMatchObject({ done: true, courseId: course.id });
      expect(result.triggers).toBe(0);
    } finally { await ctx.close(); }
  });
  it('邮箱工厂异常不破坏同步结果，之后可以重试', async () => {
    const mail = vi.fn().mockImplementationOnce(() => { throw new Error('keychain'); }).mockReturnValue(null);
    const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail });
    try {
      expect((await ctx.syncAll(now)).errors).toEqual(['邮箱：keychain']);
      expect((await ctx.syncAll(now)).errors).toEqual([]);
    } finally { await ctx.close(); }
  });
  it('eLearning 失败仍同步邮箱', async () => {
    const mail = new DemoMailClient(() => now);
    const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => { throw new Error('offline'); }, mail: () => mail });
    try {
      const result = await ctx.syncAll(now);
      expect(result.errors).toEqual(['eLearning：offline']); expect(result.mail).toBeDefined();
      expect(ctx.repo.listItems({ kind: 'email' }).length).toBeGreaterThan(0);
    } finally { await ctx.close(); }
  });
});
