/** 本地数据库结构（PRD §7.7）。修改后请同步 src/shared/types.ts。 */
export const SCHEMA_VERSION = 2;

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, section TEXT, name TEXT NOT NULL, term TEXT,
  teachers TEXT NOT NULL DEFAULT '[]', elearning_id TEXT UNIQUE, icourse_id TEXT,
  match_status TEXT NOT NULL DEFAULT 'auto', assessments TEXT NOT NULL DEFAULT '[]', schedule TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT, published_at TEXT NOT NULL, due_at TEXT,
  course_id TEXT, done INTEGER NOT NULL DEFAULT 0, sender TEXT,
  ai_category TEXT, ai_summary TEXT, ai_action TEXT, ai_model_used TEXT, raw TEXT,
  UNIQUE (source, kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_items_due ON items (due_at);
CREATE INDEX IF NOT EXISTS idx_items_course ON items (course_id);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, from_item_id TEXT NOT NULL, to_item_id TEXT NOT NULL,
  reason TEXT NOT NULL, confidence REAL NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (from_item_id, to_item_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, cards TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]', tool_calls TEXT NOT NULL DEFAULT '[]',
  proactive INTEGER NOT NULL DEFAULT 0, trigger TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_summaries (id TEXT PRIMARY KEY, until_msg_id TEXT NOT NULL, summary TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, source_msg_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, description TEXT, course_id TEXT,
  due_at TEXT, status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, goal_id TEXT, item_id TEXT UNIQUE, title TEXT NOT NULL, due_at TEXT,
  status TEXT NOT NULL DEFAULT 'todo', source TEXT NOT NULL, verify TEXT, reminders_sent TEXT NOT NULL DEFAULT '[]',
  local_done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY, topic TEXT NOT NULL, due_at TEXT NOT NULL, item_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', verify TEXT, created_from_msg_id TEXT
);

CREATE TABLE IF NOT EXISTS feed_cards (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL,
  done TEXT, refs TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]', score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new', dismiss_reason TEXT, dedupe_key TEXT UNIQUE, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, course_id TEXT, mime TEXT NOT NULL,
  path TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_chunks (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB);

-- 主动引擎（参考 dsh-superagent：Trigger → Eval → Decision / Ticket）
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, source_ref TEXT NOT NULL, thread_key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL, disposition TEXT NOT NULL DEFAULT 'pending', eval_id TEXT,
  UNIQUE (source, kind, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_triggers_pending ON triggers (disposition, thread_key);
CREATE TABLE IF NOT EXISTS evals (
  id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, trigger_ids TEXT NOT NULL, gate_result TEXT NOT NULL,
  assessment TEXT, decision TEXT NOT NULL, attention_cost REAL NOT NULL, reason TEXT NOT NULL,
  model_used TEXT NOT NULL, rule_mode TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS digest_queue (id TEXT PRIMARY KEY, eval_id TEXT, text TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, request TEXT NOT NULL, mandate TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL, thread_key TEXT, goal_id TEXT, verify TEXT, result_resource_id TEXT, created_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS ticket_reports (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, question TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attention_budget (date TEXT PRIMARY KEY, budget REAL NOT NULL, spent REAL NOT NULL DEFAULT 0, semester_phase TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendar (date TEXT PRIMARY KEY, week_no INTEGER, phase TEXT NOT NULL, note TEXT);

-- 全局搜索（FTS5，trigram 分词，适合中文）
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(object_type UNINDEXED, object_id UNINDEXED, title, body, tokenize='trigram');
`;

/**
 * 已有数据库的增量迁移：CREATE TABLE IF NOT EXISTS 不会给旧表加新列，这里逐个补上。
 * 只做向后兼容的加列，不删列、不改列。
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  // v2：用户在本地把平台作业标记为完成（组作业由组长提交等），与平台上的完成状态分开记录
  { table: 'tasks', column: 'local_done', ddl: 'ALTER TABLE tasks ADD COLUMN local_done INTEGER NOT NULL DEFAULT 0' },
];
