import { describe, expect, it } from 'vitest';
import { coursesOn, freeSlots } from '../src/main/today';
import type { Course } from '../src/shared/types';

const course = (name: string, schedule: Course['schedule']): Course => ({ id: name, code: name, name, teachers: [], matchStatus: 'auto', schedule });

describe('今日课程与空闲时段', () => {
  it('只取当天（按星期几）的课，并按开始时间排序', () => {
    const tue = new Date('2026-11-10T09:00:00'); // 周二
    const list = coursesOn([
      course('数据结构', [{ weekday: 2, start: '13:30', end: '15:10', location: 'H2215' }, { weekday: 4, start: '10:00', end: '11:40' }]),
      course('数学分析 III', [{ weekday: 2, start: '08:00', end: '09:40', location: 'H3109' }]),
      course('大学物理 B', [{ weekday: 3, start: '10:00', end: '11:40' }]),
    ], tue);
    expect(list.map((c) => c.name)).toEqual(['数学分析 III', '数据结构']);
  });

  it('空闲时段：扣掉上课时间，只保留不少于 1 小时的空档', () => {
    expect(freeSlots([{ start: '08:00', end: '09:40' }, { start: '13:30', end: '15:10' }])).toEqual([
      { start: '09:40', end: '13:30' },
      { start: '15:10', end: '22:00' },
    ]);
    // 两节课之间只有 15 分钟：不算空闲
    expect(freeSlots([{ start: '08:00', end: '09:40' }, { start: '09:55', end: '11:35' }])[0]).toEqual({ start: '11:35', end: '22:00' });
    expect(freeSlots([])).toEqual([{ start: '08:00', end: '22:00' }]);
  });
});
