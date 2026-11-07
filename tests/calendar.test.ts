import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { buildCalendar, phaseFor, weekNo } from '../src/main/engine/calendar';

/** 对照《复旦大学 2026—2027 学年校历》：每周从周日开始，第 0 周为报到 / 注册周 */
describe('2026–2027 学年校历', () => {
  it.each([
    // 第一学期
    ['2026-08-30', 0], ['2026-09-05', 0], ['2026-09-06', 1], ['2026-09-07', 1],
    ['2026-10-04', 5], ['2026-11-01', 9], ['2026-11-06', 9], ['2026-12-20', 16],
    ['2026-12-27', 17], ['2027-01-03', 18], ['2027-01-09', 18],
    // 第二学期
    ['2027-02-14', 0], ['2027-02-21', 1], ['2027-03-28', 6], ['2027-05-02', 11], ['2027-06-13', 17], ['2027-06-26', 18],
  ])('%s 是第 %i 周', (date, week) => {
    expect(weekNo(date)).toBe(week);
  });

  it('寒暑假不在任何学期内', () => {
    for (const d of ['2026-08-29', '2027-01-10', '2027-02-13', '2027-06-27']) {
      expect(weekNo(d)).toBeUndefined();
      expect(phaseFor(d)).toBe('holiday');
    }
  });

  it('阶段：第 0 周开学初、第 9 周期中、第 16 周通识考试、第 17–18 周停课考试', () => {
    expect(phaseFor('2026-08-31')).toBe('course_selection');
    expect(phaseFor('2026-11-04')).toBe('midterm');
    expect(phaseFor('2026-11-10')).toBe('regular');
    expect(phaseFor('2026-12-22')).toBe('pre_exam');
    expect(phaseFor('2026-12-29')).toBe('exam');
    expect(phaseFor('2027-06-15')).toBe('exam');
  });

  it('节假日：国庆、元旦（待学校办通知），校运会停课一天', () => {
    expect(phaseFor('2026-10-02')).toBe('holiday');
    expect(phaseFor('2027-01-01')).toBe('holiday');
    const days = buildCalendar();
    expect(days.find((d) => d.date === '2027-05-14')).toMatchObject({ phase: 'holiday', note: expect.stringContaining('运动会') });
    expect(days.find((d) => d.date === '2026-12-21')?.note).toContain('通识');
  });

  it('两个学期共 266 天，各 19 周（第 0–18 周）', () => {
    expect(buildCalendar()).toHaveLength(266);
  });

  it('写入数据库时整体替换，旧校历的日期行不会残留', () => {
    const repo = new Repo(new Db(':memory:'));
    repo.setCalendar([{ date: '2027-01-10', weekNo: 18, phase: 'exam' }]);
    repo.setCalendar(buildCalendar());
    expect(repo.calendarDay('2027-01-10')).toBeUndefined();
    expect(repo.calendarDay('2026-11-06')).toMatchObject({ weekNo: 9, phase: 'midterm' });
  });
});
