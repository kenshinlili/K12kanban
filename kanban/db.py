"""学习看板 - 数据库层（SQLite）"""
import sqlite3
import os
from datetime import datetime

DB_PATH = os.environ.get(
    'KANBAN_DB_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'kanban.db')
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  name TEXT NOT NULL,
  org_type TEXT NOT NULL,
  track_mode TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  checkin_date TEXT NOT NULL,
  duration_min INTEGER,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_ai',
  current_run_id INTEGER,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(board_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT,
  uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT,
  operator TEXT,
  comment TEXT,
  created_at TEXT,
  UNIQUE(checkin_id, version)
);

CREATE TABLE IF NOT EXISTS wrong_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  checkin_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  student_answer TEXT,
  correct_answer TEXT,
  error_type TEXT,
  knowledge_point TEXT,
  confidence REAL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending',
  review_comment TEXT,
  reviewer_id TEXT,
  reviewed_at TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_id INTEGER NOT NULL,
  run_id INTEGER,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  to_member_id TEXT,
  created_at TEXT
);

-- 错题复习计划（间隔重复）
CREATE TABLE IF NOT EXISTS review_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wrong_question_id INTEGER NOT NULL,
  current_stage INTEGER DEFAULT 0,      -- 0=待复习 1/2/3/4 已通过的次数
  next_review_date TEXT NOT NULL,       -- 下次复习日期 YYYY-MM-DD
  history TEXT,                         -- JSON: [{date, result, stage}]
  status TEXT DEFAULT 'pending',        -- pending / mastered / dropped
  created_at TEXT,
  UNIQUE(wrong_question_id)
);

-- 复习规则：按科目配置阶段间隔（天数）
CREATE TABLE IF NOT EXISTS review_rules (
  subject TEXT PRIMARY KEY,
  intervals TEXT NOT NULL,              -- JSON: [2,7,30,30]
  max_stages INTEGER NOT NULL           -- 通过多少次算掌握
);

CREATE INDEX IF NOT EXISTS idx_checkins_board_date ON checkins(board_id, checkin_date);
CREATE INDEX IF NOT EXISTS idx_photos_checkin ON photos(checkin_id);
CREATE INDEX IF NOT EXISTS idx_wq_run ON wrong_questions(run_id);
CREATE INDEX IF NOT EXISTS idx_actions_checkin ON review_actions(checkin_id);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON review_schedules(next_review_date, status);
"""

MEMBERS = [
    ('dad', '爸爸', 'parent', '👨', 1),
    ('mom', '妈妈', 'parent', '👩', 2),
    ('child', '李迦一', 'child', '🧒', 3),
]

# 复习规则：按科目配置阶段间隔天数
REVIEW_RULES = [
    ('语文', '[2,7,30,30]', 4),    # 第1/2/3/4 次分别在入库后 2/7/30/30 天
    ('数学', '[1,30]', 2),         # 数学只重复 2 次，间隔长
    ('英语', '[2,7,30,30]', 4),
]

BOARDS = [
    # 语文
    ('cn_school_drill', '语文', '校内精练', '校内', '单元', 1),
    ('cn_dictation', '语文', '听写', '校内', '单元', 2),
    ('cn_essay', '语文', '作文', '校内', '单元', 3),
    ('cn_xes', '语文', '学而思', '校外', '主题', 4),
    # 数学
    ('math_school', '数学', '校内', '校内', '主题', 5),
    ('math_outside', '数学', '校外', '校外', '主题', 6),
    # 英语
    ('en_school', '英语', '校内', '校内', '单元', 7),
    ('en_outside', '英语', '校外', '校外', '主题', 8),
]

KNOWLEDGE_POINTS = {
    'cn_school_drill': ['第一单元', '第二单元', '第三单元', '第四单元',
                        '第五单元', '第六单元', '第七单元', '第八单元'],
    'cn_dictation': ['第一单元', '第二单元', '第三单元', '第四单元',
                     '第五单元', '第六单元', '第七单元', '第八单元'],
    'cn_essay': ['第一单元', '第二单元', '第三单元', '第四单元',
                 '第五单元', '第六单元', '第七单元', '第八单元'],
    'cn_xes': ['基础知识', '阅读理解', '作文技法', '古诗文'],
    'math_school': ['大数的认识', '公顷和平方千米', '角的度量', '三位数乘两位数',
                    '平行四边形和梯形', '除数是两位数的除法', '条形统计图', '数学广角'],
    'math_outside': ['计算', '应用题', '几何', '数论', '行程'],
    'en_school': ['Unit 1', 'Unit 2', 'Unit 3', 'Unit 4', 'Unit 5', 'Unit 6'],
    'en_outside': ['词汇', '语法', '阅读', '听力'],
}


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        # 种子成员
        for m in MEMBERS:
            conn.execute(
                'INSERT OR IGNORE INTO members (id, name, role, avatar, sort_order) '
                'VALUES (?, ?, ?, ?, ?)', m)
        # 种子板块
        for b in BOARDS:
            conn.execute(
                'INSERT OR IGNORE INTO boards (id, subject, name, org_type, track_mode, sort_order) '
                'VALUES (?, ?, ?, ?, ?, ?)', b)
        # 种子知识点
        for board_id, points in KNOWLEDGE_POINTS.items():
            for i, name in enumerate(points, 1):
                exists = conn.execute(
                    'SELECT 1 FROM knowledge_points WHERE board_id=? AND name=?',
                    (board_id, name)).fetchone()
                if not exists:
                    conn.execute(
                        'INSERT INTO knowledge_points (board_id, name, sort_order) '
                        'VALUES (?, ?, ?)', (board_id, name, i))
        # 种子复习规则
        for subject, intervals, max_stages in REVIEW_RULES:
            conn.execute(
                'INSERT OR IGNORE INTO review_rules (subject, intervals, max_stages) '
                'VALUES (?, ?, ?)', (subject, intervals, max_stages))
        conn.commit()
    finally:
        conn.close()


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def today_str():
    return datetime.now().strftime('%Y-%m-%d')


if __name__ == '__main__':
    init_db()
    print('database initialized at', DB_PATH)
