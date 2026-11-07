import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';

/** 同学们本地已有的旧数据库：启动时自动补上新列，数据不丢 */
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('数据库迁移', () => {
  it('旧版 tasks 表（没有 local_done 列）打开后自动补列，原有任务保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fudaner-db-'));
    dirs.push(dir);
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, goal_id TEXT, item_id TEXT UNIQUE, title TEXT NOT NULL, due_at TEXT,
      status TEXT NOT NULL DEFAULT 'todo', source TEXT NOT NULL, verify TEXT, reminders_sent TEXT NOT NULL DEFAULT '[]')`);
    old.exec("INSERT INTO tasks (id, title, status, source) VALUES ('t1', '旧任务', 'done', 'user')");
    old.close();

    const db = new Db(path);
    const repo = new Repo(db);
    expect(repo.getTask('t1')).toMatchObject({ title: '旧任务', status: 'done', localDone: false });
    // 再次打开不会重复加列
    db.close();
    expect(() => new Db(path).close()).not.toThrow();
  });
});
