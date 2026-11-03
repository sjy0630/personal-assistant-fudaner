import { describe, expect, it } from 'vitest';
import { findBestMatch, matchCourse, parseCourseCode, senderBelongsToCourse } from '@fudaner/mcp-fudan-courses';

describe('课程总表匹配（PRD §7.4）', () => {
  it('解析课程代码和教学班', () => {
    expect(parseCourseCode('COMP130004.01')).toEqual({ base: 'COMP130004', section: '01' });
    expect(parseCourseCode('math120003')).toEqual({ base: 'MATH120003', section: undefined });
  });

  it('课程代码 + 教学班一致 → 自动关联', () => {
    expect(matchCourse({ code: 'COMP130004.01', name: '数据结构', teachers: [] }, { code: 'COMP130004', section: '01', name: '数据结构与算法', teachers: [] })).toBe('auto');
  });

  it('只有课程名 + 教师一致 → 待确认', () => {
    expect(matchCourse({ name: '数据结构', teachers: ['王老师'] }, { code: 'X', name: '数据结构（荣誉）', teachers: ['王老师'] })).toBe('pending');
  });

  it('教学班不同 → 不关联', () => {
    expect(matchCourse({ code: 'COMP130004.01', name: '数据结构', teachers: ['王'] }, { code: 'COMP130004.02', name: '离散数学', teachers: ['李'] })).toBe('none');
  });

  it('优先返回自动匹配', () => {
    const r = findBestMatch({ code: 'COMP130004.01', name: '数据结构', teachers: ['王老师'] }, [
      { code: 'COMP999', name: '数据结构', teachers: ['王老师'] },
      { code: 'COMP130004.01', name: 'DS', teachers: [] },
    ]);
    expect(r?.result).toBe('auto');
    expect(r?.item.name).toBe('DS');
  });

  it('发件人是否为课程教师 / 助教（大小写不敏感）', () => {
    expect(senderBelongsToCourse('Li.ZhuJiao@m.fudan.edu.cn', ['li.zhujiao@m.fudan.edu.cn'])).toBe(true);
  });
});
