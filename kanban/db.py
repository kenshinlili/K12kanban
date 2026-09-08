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
  sort_order INTEGER DEFAULT 0,
  no_checkin INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0
);

-- 知识点：两级结构（parent_id 指向一级「单元」，NULL 表示一级或扁平项）
CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  source TEXT DEFAULT 'manual',      -- 'seeded' = 系统默认值，'manual' = 用户手动新增/修改
  seed_key TEXT                      -- 系统种子的唯一标识（board_id:...），用户手动新增为 NULL
);

-- 已下发过的默认知识点：保证用户手动删除后不会被再次自动恢复
CREATE TABLE IF NOT EXISTS seeded_knowledge_points (
  board_id TEXT NOT NULL,
  seed_key TEXT NOT NULL,
  seeded_at TEXT,
  PRIMARY KEY (board_id, seed_key)
);

-- 打卡 / 活动记录：entry_type = daily(每日打卡) | homework(作业，可滞后补交)
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  checkin_date TEXT NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'daily',
  kp_id INTEGER,
  kp_name TEXT,
  duration_min INTEGER,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_ai',
  current_run_id INTEGER,
  created_at TEXT,
  updated_at TEXT
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
CREATE INDEX IF NOT EXISTS idx_kp_board ON knowledge_points(board_id);
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
    # 语文：V1.30 看板只保留校内主三卡，学而思体系归档隐藏
    ('cn_school_drill', '语文', '校内精练', '校内', '单元', 1, 0),
    ('cn_dictation', '语文', '听写', '校内', '单元', 2, 0),
    ('cn_essay', '语文', '作文', '校内', '单元', 3, 0),
    # 数学
    ('math_school', '数学', '校内', '校内', '主题', 4, 0),
    ('math_outside', '数学', '校外', '校外', '主题', 5, 0),
    # 英语
    ('en_school', '英语', '校内', '校内', '单元', 6, 0),
    ('en_outside', '英语', '校外', '校外', '主题', 7, 0),
]

# ---------------------------------------------------------------------------
# 语文四年级上册（部编版·五四制 2026 秋）校内目录 —— 两级：单元 → 课文/活动
# 来源：电子课本网「四年级语文上册(2026秋版)(五四制-部编版)」
# ---------------------------------------------------------------------------
CN_LESSONS = {
    '第一单元': ['1 观潮', '2 繁星', '3* 现代诗二首', '口语交际·我们与环境',
                 '习作·推荐一个好地方', '语文园地'],
    '第二单元': ['4 一个豆荚里的五粒豆', '5 夜间飞行的秘密', '6 方帽子店',
                 '7* 田忌赛马', '习作·我的家人', '语文园地'],
    '第三单元': ['8 古诗三首', '9 爬山虎的脚', '10 蟋蟀的住宅',
                 '口语交际·爱护眼睛，保护视力', '习作·写观察日记', '语文园地'],
    '第四单元': ['11 盘古开天地', '12 精卫填海', '13 普罗米修斯', '14* 女娲补天',
                 '习作·我和__过一天', '语文园地'],
    '第五单元': ['15 麻雀', '16 爬天都峰', '习作·生活万花筒'],
    '第六单元': ['17 长城', '18 颐和园', '19* 秦兵马俑',
                 '口语交际·我是小小讲解员', '习作·中国的世界文化遗产', '语文园地'],
    '第七单元': ['20 牛和鹅', '21 一只窝囊的大老虎', '22* 陀螺', '23 王戎不取道旁李',
                 '口语交际·安慰', '习作·我的心儿怦怦跳', '语文园地'],
    '第八单元': ['24 我将无我，不负人民', '25 为中华之崛起而读书', '26* 延安，我把你追寻',
                 '27 古诗三首', '习作·写信', '语文园地'],
}


def _dictation_items(unit_items):
    """听写板块：只保留课文（去掉口语交际/习作/语文园地），并补词语表。"""
    items = [x for x in unit_items
             if not x.startswith(('口语交际', '习作', '语文园地'))]
    return items


def _essay_items(unit_items):
    """作文板块：只保留该单元的习作项。"""
    return [x for x in unit_items if x.startswith('习作')]


# 两级板块（语文校内三个板块）
TREE_KNOWLEDGE = {
    'cn_school_drill': [(u, items) for u, items in CN_LESSONS.items()],
    'cn_dictation': [(u, _dictation_items(items)) for u, items in CN_LESSONS.items()],
    'cn_essay': [(u, _essay_items(items)) for u, items in CN_LESSONS.items()],
}

# 扁平板块（校外 / 数学 / 英语）
FLAT_KNOWLEDGE = {
    # 学而思只保留两个归口：天天练 + 日积月累
    'cn_xes': ['学而思天天练', '学而思日积月累'],
    'cn_xes_daily': ['天天练'],     # 学而思：不分单元，每日做完就上传作业
    # 'cn_xes_accumulate': 日积月累目录用户稍后上传，先留空板块
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


def migrate_db(conn):
    """对已有数据库做增量字段迁移（SQLite 不支持 IF NOT EXISTS ADD COLUMN）。"""
    # 1. boards 加 no_checkin（考试类板块不需要每日打卡）
    board_cols = [r['name'] for r in conn.execute('PRAGMA table_info(boards)').fetchall()]
    if 'no_checkin' not in board_cols:
        conn.execute("ALTER TABLE boards ADD COLUMN no_checkin INTEGER DEFAULT 0")
    conn.execute("UPDATE boards SET no_checkin=1 WHERE id='cn_exam'")
    # V1.30：boards 加 archived（软删除/隐藏），并把语文非主三卡归档
    if 'archived' not in board_cols:
        conn.execute("ALTER TABLE boards ADD COLUMN archived INTEGER DEFAULT 0")
    KEEP_CN_BOARDS = {'cn_school_drill', 'cn_dictation', 'cn_essay'}
    conn.execute(
        "UPDATE boards SET archived=1 WHERE subject='语文' AND id NOT IN (?, ?, ?)",
        tuple(KEEP_CN_BOARDS))

    # 2. wrong_questions 加 answer_candidates
    cols = [r['name'] for r in conn.execute('PRAGMA table_info(wrong_questions)').fetchall()]
    if 'answer_candidates' not in cols:
        conn.execute("ALTER TABLE wrong_questions ADD COLUMN answer_candidates TEXT")

    # 2. knowledge_points 加 parent_id（两级结构）
    kp_cols = [r['name'] for r in conn.execute('PRAGMA table_info(knowledge_points)').fetchall()]
    if 'parent_id' not in kp_cols:
        conn.execute("ALTER TABLE knowledge_points ADD COLUMN parent_id INTEGER")

    # 3. checkins 加 entry_type / kp_name（并去掉旧的 UNIQUE(board_id, checkin_date)，
    #    使「每日打卡」和「作业」能在同一天共存、作业可滞后补交）
    ci_cols = [r['name'] for r in conn.execute('PRAGMA table_info(checkins)').fetchall()]
    if 'entry_type' not in ci_cols or 'kp_name' not in ci_cols:
        conn.execute('ALTER TABLE checkins RENAME TO checkins_old')
        conn.execute('''CREATE TABLE checkins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          board_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          checkin_date TEXT NOT NULL,
          entry_type TEXT NOT NULL DEFAULT 'daily',
          kp_id INTEGER,
          kp_name TEXT,
          duration_min INTEGER,
          note TEXT,
          status TEXT NOT NULL DEFAULT 'pending_ai',
          current_run_id INTEGER,
          created_at TEXT,
          updated_at TEXT
        )''')
        conn.execute('''INSERT INTO checkins
            (id, board_id, member_id, checkin_date, entry_type, kp_id, kp_name,
             duration_min, note, status, current_run_id, created_at, updated_at)
          SELECT id, board_id, member_id, checkin_date, 'daily', NULL, NULL,
             duration_min, note, status, current_run_id, created_at, updated_at
          FROM checkins_old''')
        conn.execute('DROP TABLE checkins_old')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_checkins_board_date '
                     'ON checkins(board_id, checkin_date)')

    # 4. 清理 wrong_questions.correct_answer 里历史残留的拼音括号
    #    V1.10 改版：正解不再自动加拼音，已经入库的正解也清理掉
    #    匹配模式：「汉字（拼音字母与声调）」，例如「风平浪静（fēng píng làng jìng）」
    import re as _re_pin
    _pin_re = _re_pin.compile(r'（[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü\s]+）')
    fixed = 0
    for row in conn.execute("SELECT id, correct_answer FROM wrong_questions WHERE correct_answer LIKE '%（%'").fetchall():
        old = row['correct_answer'] or ''
        new = _pin_re.sub('', old)
        # 同时合并相邻多余的分号/逗号：;; → ;，末尾标点也清理
        new = _re_pin.sub(r'[；;]{2,}', '；', new).strip()
        if new != old:
            conn.execute("UPDATE wrong_questions SET correct_answer=? WHERE id=?", (new, row['id']))
            fixed += 1
    if fixed:
        print(f"[migrate] cleaned pinyin from {fixed} correct_answer rows")

    # 5. V1.25：知识点种子改为「只补缺失、不恢复手动删除」。
    #    新增 source/seed_key 字段和 seeded_knowledge_points 表，用于区分系统默认值
    #    与用户手动调整；用户手动删除/新增的知识点都不会被自动恢复或清空。
    kp_cols = [r['name'] for r in conn.execute('PRAGMA table_info(knowledge_points)').fetchall()]
    if 'source' not in kp_cols:
        conn.execute("ALTER TABLE knowledge_points ADD COLUMN source TEXT DEFAULT 'manual'")
    if 'seed_key' not in kp_cols:
        conn.execute('ALTER TABLE knowledge_points ADD COLUMN seed_key TEXT')

    # 确保 seeded_knowledge_points 表存在（老库可能没建）
    conn.execute('''CREATE TABLE IF NOT EXISTS seeded_knowledge_points (
      board_id TEXT NOT NULL,
      seed_key TEXT NOT NULL,
      seeded_at TEXT,
      PRIMARY KEY (board_id, seed_key)
    )''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_kp_seed ON knowledge_points(seed_key)')

    # 一次性回填：把当前数据库里还存在的默认知识点标记为 source='seeded' 并登记。
    # 用户已经手动删除的默认项不再重建——因为 seeded_knowledge_points 里没有记录，
    # 后续 init_db 也不会再插入它们。
    _backfill_seeded_knowledge(conn)


def _is_seeded(conn, board_id, seed_key):
    """检查某个默认值是否已经被下发过（即使后来用户删了，也视为已下发，不再重建）。"""
    return conn.execute(
        'SELECT 1 FROM seeded_knowledge_points WHERE board_id=? AND seed_key=?',
        (board_id, seed_key)).fetchone() is not None


def _mark_seeded(conn, board_id, seed_key):
    conn.execute(
        'INSERT OR IGNORE INTO seeded_knowledge_points (board_id, seed_key, seeded_at) '
        'VALUES (?, ?, ?)', (board_id, seed_key, now_str()))


def _backfill_seeded_knowledge(conn):
    """一次性回填：把当前数据库里还存在的系统默认值标记为 source='seeded'，
    并登记到 seeded_knowledge_points，防止后续被重新恢复。
    只在 seeded_knowledge_points 为空且 knowledge_points 已有数据时执行。"""
    seeded_count = conn.execute('SELECT COUNT(*) AS n FROM seeded_knowledge_points').fetchone()['n']
    kp_count = conn.execute('SELECT COUNT(*) AS n FROM knowledge_points').fetchone()['n']
    if seeded_count > 0 or kp_count == 0:
        return

    # 两级板块（语文校内）
    for board_id, tree in TREE_KNOWLEDGE.items():
        for unit, items in tree:
            unit_key = f"{board_id}:{unit}"
            row = conn.execute(
                'SELECT id FROM knowledge_points WHERE board_id=? AND name=? AND parent_id IS NULL',
                (board_id, unit)).fetchone()
            if row:
                conn.execute(
                    "UPDATE knowledge_points SET source='seeded', seed_key=? WHERE id=?",
                    (unit_key, row['id']))
                _mark_seeded(conn, board_id, unit_key)
            for item in items:
                item_key = f"{board_id}:{unit}:{item}"
                r2 = conn.execute(
                    'SELECT id FROM knowledge_points WHERE board_id=? AND name=? AND parent_id=?',
                    (board_id, item, row['id'] if row else None)).fetchone()
                if r2:
                    conn.execute(
                        "UPDATE knowledge_points SET source='seeded', seed_key=? WHERE id=?",
                        (item_key, r2['id']))
                    _mark_seeded(conn, board_id, item_key)

    # 扁平板块
    for board_id, points in FLAT_KNOWLEDGE.items():
        for name in points:
            key = f"{board_id}:{name}"
            row = conn.execute(
                'SELECT id FROM knowledge_points WHERE board_id=? AND name=? AND parent_id IS NULL',
                (board_id, name)).fetchone()
            if row:
                conn.execute(
                    "UPDATE knowledge_points SET source='seeded', seed_key=? WHERE id=?",
                    (key, row['id']))
                _mark_seeded(conn, board_id, key)

    # 考试和测验板块：按语文现有单元补的单元级默认项
    EXAM_NAME = '考试和测验'
    unit_rows = conn.execute(
        "SELECT kp.id, kp.name FROM knowledge_points kp "
        "JOIN boards b ON b.id = kp.board_id "
        "WHERE b.subject='语文' AND kp.parent_id IS NULL "
        "  AND b.track_mode='单元' AND b.id!='cn_exam' "
        "ORDER BY kp.sort_order, kp.id").fetchall()
    seen = set()
    for r in unit_rows:
        if r['name'] in seen:
            continue
        seen.add(r['name'])
        unit_key = f"cn_exam:{r['name']}"
        exam_unit = conn.execute(
            'SELECT id FROM knowledge_points WHERE board_id=? AND name=? AND parent_id IS NULL',
            ('cn_exam', r['name'])).fetchone()
        if exam_unit:
            conn.execute(
                "UPDATE knowledge_points SET source='seeded', seed_key=? WHERE id=?",
                (unit_key, exam_unit['id']))
            _mark_seeded(conn, 'cn_exam', unit_key)
        child = conn.execute(
            'SELECT id FROM knowledge_points WHERE board_id=? AND name=? AND parent_id=?',
            ('cn_exam', EXAM_NAME, exam_unit['id'] if exam_unit else None)).fetchone()
        if child:
            child_key = f"cn_exam:{r['name']}:{EXAM_NAME}"
            conn.execute(
                "UPDATE knowledge_points SET source='seeded', seed_key=? WHERE id=?",
                (child_key, child['id']))
            _mark_seeded(conn, 'cn_exam', child_key)


def _seed_tree(conn, board_id, tree):
    """两级知识点种子：tree = [(单元名, [课文/活动...]), ...]
    使用 seeded_knowledge_points 保证默认值只补一次，用户手动删除后不再恢复。"""
    for ui, (unit, items) in enumerate(tree, 1):
        unit_key = f"{board_id}:{unit}"
        if _is_seeded(conn, board_id, unit_key):
            unit_row = conn.execute(
                'SELECT id FROM knowledge_points WHERE seed_key=?',
                (unit_key,)).fetchone()
            unit_id = unit_row['id'] if unit_row else None
        else:
            unit_id = conn.execute(
                'SELECT id FROM knowledge_points WHERE board_id=? AND name=? AND parent_id IS NULL',
                (board_id, unit)).fetchone()
            if unit_id:
                unit_id = unit_id['id']
            else:
                cur = conn.execute(
                    'INSERT INTO knowledge_points (board_id, name, parent_id, sort_order, source, seed_key) '
                    'VALUES (?,?,?,?,?,?)', (board_id, unit, None, ui, 'seeded', unit_key))
                unit_id = cur.lastrowid
            _mark_seeded(conn, board_id, unit_key)

        if unit_id is None:
            continue

        for ii, item in enumerate(items, 1):
            item_key = f"{board_id}:{unit}:{item}"
            if _is_seeded(conn, board_id, item_key):
                continue
            exists = conn.execute(
                'SELECT 1 FROM knowledge_points WHERE board_id=? AND name=? AND parent_id=?',
                (board_id, item, unit_id)).fetchone()
            if not exists:
                conn.execute(
                    'INSERT INTO knowledge_points (board_id, name, parent_id, sort_order, source, seed_key) '
                    'VALUES (?,?,?,?,?,?)', (board_id, item, unit_id, ii, 'seeded', item_key))
            _mark_seeded(conn, board_id, item_key)


def _seed_flat(conn, board_id, points):
    """扁平板块默认值种子，用户手动删除后不再恢复。"""
    for i, name in enumerate(points, 1):
        key = f"{board_id}:{name}"
        if _is_seeded(conn, board_id, key):
            continue
        exists = conn.execute(
            'SELECT 1 FROM knowledge_points WHERE board_id=? AND name=? AND parent_id IS NULL',
            (board_id, name)).fetchone()
        if not exists:
            conn.execute(
                'INSERT INTO knowledge_points (board_id, name, parent_id, sort_order, source, seed_key) '
                'VALUES (?,?,?,?,?,?)', (board_id, name, None, i, 'seeded', key))
        _mark_seeded(conn, board_id, key)


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        migrate_db(conn)
        # 种子成员
        for m in MEMBERS:
            conn.execute(
                'INSERT OR IGNORE INTO members (id, name, role, avatar, sort_order) '
                'VALUES (?, ?, ?, ?, ?)', m)
        # 种子板块（V1.30：新板块默认未归档）
        for b in BOARDS:
            conn.execute(
                'INSERT OR IGNORE INTO boards '
                '(id, subject, name, org_type, track_mode, sort_order, no_checkin, archived) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, 0)', b)
        # 种子知识点：两级板块 + 扁平板块
        for board_id, tree in TREE_KNOWLEDGE.items():
            _seed_tree(conn, board_id, tree)
        for board_id, points in FLAT_KNOWLEDGE.items():
            _seed_flat(conn, board_id, points)
        # 种子复习规则
        for subject, intervals, max_stages in REVIEW_RULES:
            conn.execute(
                'INSERT OR IGNORE INTO review_rules (subject, intervals, max_stages) '
                'VALUES (?, ?, ?)', (subject, intervals, max_stages))
        ensure_exam_knowledge(conn)
        conn.commit()
    finally:
        conn.close()


def ensure_exam_knowledge(conn):
    """V1.22：为语文每个单元补一个「考试和测验」知识点（幂等，可重复执行）。

    用户定的目录规范：每个单元除了课文，还要有单元级的归口——
      · 习作（作文）→ 已有独立板块 cn_essay
      · 考试和测验   → 本函数建 cn_exam 板块，并在每个单元下建同名子项

    这样单元测验 / 月考 / 期中期末都能找到知识点归口，且同一单元可反复提交。
    放在种子数据之后执行，因此对已导入的真实目录同样生效。
    """
    EXAM_BOARD = ('cn_exam', '语文', '考试和测验', '校内', '单元', 5, 1)
    EXAM_NAME = '考试和测验'
    conn.execute(
        'INSERT OR IGNORE INTO boards '
        '(id, subject, name, org_type, track_mode, sort_order, no_checkin, archived) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1)', EXAM_BOARD)
    # 确保考试板块标记为「无需打卡」且归档（V1.30 语文看板只保留三个主卡片）
    conn.execute("UPDATE boards SET no_checkin=1, archived=1 WHERE id='cn_exam'")

    # 语文「单元制」板块下的一级知识点（单元）按名字去重，作为建考试项的基准。
    # 只取 track_mode='单元' 且不是考试板块本身，避免把扁平板块的顶层知识点也当成单元。
    rows = conn.execute(
        "SELECT kp.id, kp.name FROM knowledge_points kp "
        "JOIN boards b ON b.id = kp.board_id "
        "WHERE b.subject='语文' AND kp.parent_id IS NULL "
        "  AND b.track_mode='单元' AND b.id!='cn_exam' "
        "ORDER BY kp.sort_order, kp.id").fetchall()
    unit_names = []
    for r in rows:
        if r['name'] not in unit_names:
            unit_names.append(r['name'])

    for unit_name in unit_names:
        unit_key = f"cn_exam:{unit_name}"
        seeded = _is_seeded(conn, 'cn_exam', unit_key)
        if seeded:
            row = conn.execute(
                'SELECT id FROM knowledge_points WHERE seed_key=?', (unit_key,)).fetchone()
            pid = row['id'] if row else None
        else:
            row = conn.execute(
                'SELECT id FROM knowledge_points '
                'WHERE board_id=? AND name=? AND parent_id IS NULL',
                ('cn_exam', unit_name)).fetchone()
            if row:
                pid = row['id']
            else:
                pid = conn.execute(
                    'INSERT INTO knowledge_points (board_id, name, parent_id, sort_order, source, seed_key) '
                    'VALUES (?, ?, NULL, 0, ?, ?)',
                    ('cn_exam', unit_name, 'seeded', unit_key)).lastrowid
            _mark_seeded(conn, 'cn_exam', unit_key)

        if pid is None:
            continue

        child_key = f"cn_exam:{unit_name}:{EXAM_NAME}"
        if _is_seeded(conn, 'cn_exam', child_key):
            continue
        exists = conn.execute(
            'SELECT id FROM knowledge_points '
            'WHERE board_id=? AND parent_id=? AND name=?',
            ('cn_exam', pid, EXAM_NAME)).fetchone()
        if not exists:
            # sort_order=99 保证排在同单元其他课文之后
            conn.execute(
                'INSERT INTO knowledge_points (board_id, name, parent_id, sort_order, source, seed_key) '
                'VALUES (?, ?, ?, 99, ?, ?)',
                ('cn_exam', EXAM_NAME, pid, 'seeded', child_key))
        _mark_seeded(conn, 'cn_exam', child_key)


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def today_str():
    return datetime.now().strftime('%Y-%m-%d')


if __name__ == '__main__':
    init_db()
    print('database initialized at', DB_PATH)
