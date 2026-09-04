"""李迦一 K12 学习看板 - Flask 服务"""
import os
import uuid
import json
import re
import io
import zipfile
from datetime import datetime, timedelta

from flask import Flask, request, jsonify, send_from_directory, send_file
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.environ.get(
    'KANBAN_INSTANCE',
    os.path.join(os.path.dirname(BASE_DIR), 'instance')
)
DATA_DIR = os.path.join(INSTANCE_DIR, 'data')
UPLOAD_DIR = os.path.join(INSTANCE_DIR, 'uploads')
STATIC_DIR = os.path.join(BASE_DIR, 'static')
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.environ['KANBAN_DB_PATH'] = os.path.join(DATA_DIR, 'kanban.db')

import db

try:
    from pypinyin import lazy_pinyin, Style
    HAS_PINYIN = True
except ImportError:
    HAS_PINYIN = False

ALLOWED_EXT = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'}

app = Flask(__name__, static_folder=None)


# ---------------- helpers ----------------

def row2dict(r):
    return {k: r[k] for k in r.keys()}


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXT


def log_action(conn, checkin_id, run_id, actor_id, action, comment=None, to_member_id=None):
    conn.execute(
        'INSERT INTO review_actions (checkin_id, run_id, actor_id, action, comment, to_member_id, created_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        (checkin_id, run_id, actor_id, action, comment, to_member_id, db.now_str()))


def get_or_create_run(conn, checkin_id):
    """返回当前 pending 的 run，没有则新建下一个版本"""
    run = conn.execute(
        'SELECT * FROM ai_runs WHERE checkin_id=? AND status=? ORDER BY version DESC LIMIT 1',
        (checkin_id, 'pending')).fetchone()
    if run:
        return run
    max_ver = conn.execute(
        'SELECT COALESCE(MAX(version),0) AS m FROM ai_runs WHERE checkin_id=?',
        (checkin_id,)).fetchone()['m']
    cur = conn.execute(
        'INSERT INTO ai_runs (checkin_id, version, status, created_at) VALUES (?,?,?,?)',
        (checkin_id, max_ver + 1, 'pending', db.now_str()))
    return conn.execute('SELECT * FROM ai_runs WHERE id=?', (cur.lastrowid,)).fetchone()


def get_review_rule(conn, subject):
    """获取科目的复习规则"""
    r = conn.execute(
        'SELECT * FROM review_rules WHERE subject=?', (subject,)).fetchone()
    if not r:
        return {'intervals': [2, 7, 30, 30], 'max_stages': 4}
    return {'intervals': json.loads(r['intervals']), 'max_stages': r['max_stages']}


_HAN_RE = re.compile(r'[\u4e00-\u9fff]+')


def _attach_pinyin(text):
    """为字符串中的汉字段自动追加拼音标注，例如「风平浪静」→「风平浪静（fēng píng làng jìng）」。
    已经带括号拼音的段落不重复处理；非纯汉字（数字/英文/标点）保持原样。"""
    if not text or not HAS_PINYIN:
        return text
    out = []
    i = 0
    for m in _HAN_RE.finditer(text):
        if m.start() > i:
            out.append(text[i:m.start()])
        han = m.group()
        pinyin = ' '.join(lazy_pinyin(han, style=Style.TONE))
        out.append(f'{han}（{pinyin}）')
        i = m.end()
    if i < len(text):
        out.append(text[i:])
    return ''.join(out) if out else text


def auto_pinyin_questions(conn, questions, subject):
    """对语文/英语题的 content/correct_answer 字段自动加拼音（如果还没有括号拼音）"""
    if subject not in ('语文', '英语') or not HAS_PINYIN:
        return questions
    for q in questions:
        # content 已有括号拼音则跳过
        if '（' not in (q.get('content') or ''):
            q['content'] = _attach_pinyin(q.get('content', ''))
        if '（' not in (q.get('correct_answer') or ''):
            q['correct_answer'] = _attach_pinyin(q.get('correct_answer', ''))
    return questions


def schedule_initial_review(conn, wrong_question_id, subject):
    """错题首次入库：建一个 schedule，next_review_date = 今天 + intervals[0]"""
    rule = get_review_rule(conn, subject)
    first = rule['intervals'][0] if rule['intervals'] else 2
    next_date = (datetime.now() + timedelta(days=first)).strftime('%Y-%m-%d')
    conn.execute(
        'INSERT OR REPLACE INTO review_schedules '
        '(wrong_question_id, current_stage, next_review_date, history, status, created_at) '
        'VALUES (?, 0, ?, ?, ?, ?)',
        (wrong_question_id, next_date, json.dumps([], ensure_ascii=False),
         'pending', db.now_str()))


def advance_schedule(conn, schedule_id, result):
    """复习答题后推进：result='correct' → 进入下一阶段或 mastered；'wrong' → 重置回 0"""
    sch = conn.execute(
        'SELECT * FROM review_schedules WHERE id=?', (schedule_id,)).fetchone()
    if not sch:
        return None
    wq = conn.execute(
        'SELECT * FROM wrong_questions WHERE id=?', (sch['wrong_question_id'],)).fetchone()
    if not wq:
        return None
    ci = conn.execute('SELECT * FROM checkins WHERE id=?', (wq['checkin_id'],)).fetchone()
    board = conn.execute('SELECT * FROM boards WHERE id=?', (ci['board_id'],)).fetchone()
    rule = get_review_rule(conn, board['subject'])

    history = json.loads(sch['history'] or '[]')
    history.append({
        'date': db.today_str(),
        'result': result,
        'stage': sch['current_stage'] + 1,
    })

    if result == 'wrong':
        # 错误：重置回第 0 阶段，间隔从头
        new_stage = 0
        next_date = (datetime.now() + timedelta(days=rule['intervals'][0])).strftime('%Y-%m-%d')
        new_status = 'pending'
    else:
        new_stage = sch['current_stage'] + 1
        if new_stage >= rule['max_stages']:
            # 全部通过，掌握
            new_status = 'mastered'
            next_date = None
        else:
            new_status = 'pending'
            interval = rule['intervals'][new_stage] if new_stage < len(rule['intervals']) else 30
            next_date = (datetime.now() + timedelta(days=interval)).strftime('%Y-%m-%d')

    conn.execute(
        'UPDATE review_schedules SET current_stage=?, next_review_date=?, history=?, status=? '
        'WHERE id=?',
        (new_stage, next_date, json.dumps(history, ensure_ascii=False), new_status, schedule_id))
    return {'new_stage': new_stage, 'new_status': new_status, 'next_review_date': next_date}


# ---------------- static ----------------

@app.route('/')
def index():
    return send_file(os.path.join(STATIC_DIR, 'index.html'))


@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route('/uploads/<path:filename>')
def uploaded_files(filename):
    return send_from_directory(UPLOAD_DIR, filename)


# ---------------- 看板状态 ----------------

@app.route('/api/state')
def api_state():
    date = request.args.get('date') or db.today_str()
    member = request.args.get('member') or 'dad'
    conn = db.get_conn()
    try:
        members = [row2dict(r) for r in conn.execute(
            'SELECT * FROM members ORDER BY sort_order').fetchall()]
        boards = [row2dict(r) for r in conn.execute(
            'SELECT * FROM boards ORDER BY sort_order').fetchall()]

        for b in boards:
            ci = conn.execute(
                'SELECT * FROM checkins WHERE board_id=? AND checkin_date=?',
                (b['id'], date)).fetchone()
            if ci:
                b['checkin'] = row2dict(ci)
                b['photo_count'] = conn.execute(
                    'SELECT COUNT(*) AS c FROM photos WHERE checkin_id=?',
                    (ci['id'],)).fetchone()['c']
                run = conn.execute(
                    'SELECT * FROM ai_runs WHERE checkin_id=? ORDER BY version DESC LIMIT 1',
                    (ci['id'],)).fetchone()
                if run:
                    b['run'] = row2dict(run)
                    b['wrong_count'] = conn.execute(
                        'SELECT COUNT(*) AS c FROM wrong_questions WHERE run_id=?',
                        (run['id'],)).fetchone()['c']
                    b['pending_count'] = conn.execute(
                        "SELECT COUNT(*) AS c FROM wrong_questions WHERE run_id=? AND status='pending'",
                        (run['id'],)).fetchone()['c']
                else:
                    b['run'] = None
                    b['wrong_count'] = 0
                    b['pending_count'] = 0
            else:
                b['checkin'] = None
                b['photo_count'] = 0
                b['wrong_count'] = 0
                b['pending_count'] = 0
                b['run'] = None

        # 待我处理的任务（流转给我的 + 待审核的）
        todo = []
        rows = conn.execute('''
            SELECT c.*, b.subject, b.name AS board_name
            FROM checkins c JOIN boards b ON c.board_id = b.id
            WHERE c.status IN ('pending_review','transferred','rerun_requested')
            ORDER BY c.updated_at DESC LIMIT 30
        ''').fetchall()
        for r in rows:
            item = row2dict(r)
            item['photo_count'] = conn.execute(
                'SELECT COUNT(*) AS c FROM photos WHERE checkin_id=?', (r['id'],)).fetchone()['c']
            if item['status'] == 'transferred':
                act = conn.execute('''
                    SELECT * FROM review_actions WHERE checkin_id=? AND action='transfer'
                    ORDER BY id DESC LIMIT 1''', (r['id'],)).fetchone()
                item['assigned_to'] = act['to_member_id'] if act else None
            todo.append(item)

        kp = {}
        for b in boards:
            kp[b['id']] = [row2dict(x) for x in conn.execute(
                'SELECT * FROM knowledge_points WHERE board_id=? AND active=1 ORDER BY sort_order',
                (b['id'],)).fetchall()]

        return jsonify({
            'ok': True, 'date': date, 'member': member,
            'members': members, 'boards': boards,
            'knowledge_points': kp, 'todo': todo,
        })
    finally:
        conn.close()


# ---------------- 备份 ----------------

@app.route('/api/backup')
def api_backup():
    """打包数据库与上传照片为 zip，供 WorkBuddy 自动化每日拉取备份。"""
    import tempfile
    tmp = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
    tmp_path = tmp.name
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zf:
            db_path = os.path.join(DATA_DIR, 'kanban.db')
            if os.path.exists(db_path):
                zf.write(db_path, 'data/kanban.db')
            for fname in os.listdir(UPLOAD_DIR):
                fpath = os.path.join(UPLOAD_DIR, fname)
                if os.path.isfile(fpath):
                    zf.write(fpath, os.path.join('uploads', fname))
    finally:
        tmp.close()
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    resp = send_file(
        tmp_path,
        mimetype='application/zip',
        as_attachment=True,
        download_name=f'kanban-backup-{ts}.zip'
    )
    resp.call_on_close(lambda: os.remove(tmp_path) if os.path.exists(tmp_path) else None)
    return resp


# ---------------- 打卡 ----------------

@app.route('/api/checkin', methods=['POST'])
def api_checkin():
    data = request.get_json() or {}
    board_id = data.get('board_id')
    member_id = data.get('member_id') or 'dad'
    date = data.get('date') or db.today_str()
    duration = data.get('duration_min')
    note = (data.get('note') or '').strip()
    kp_id = data.get('knowledge_point_id')

    if not board_id:
        return jsonify({'ok': False, 'error': 'board_id required'}), 400

    conn = db.get_conn()
    try:
        existing = conn.execute(
            'SELECT * FROM checkins WHERE board_id=? AND checkin_date=?',
            (board_id, date)).fetchone()
        if existing:
            return jsonify({'ok': False, 'error': '今日已打卡'}), 409

        kp_name = None
        if kp_id:
            kp = conn.execute('SELECT * FROM knowledge_points WHERE id=?', (kp_id,)).fetchone()
            kp_name = kp['name'] if kp else None

        full_note = f'[{kp_name}] {note}' if kp_name else note
        cur = conn.execute(
            'INSERT INTO checkins (board_id, member_id, checkin_date, duration_min, note, '
            'status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
            (board_id, member_id, date, duration, full_note, 'pending_ai',
             db.now_str(), db.now_str()))
        cid = cur.lastrowid
        log_action(conn, cid, None, member_id, 'checkin', note)
        conn.commit()
        return jsonify({'ok': True, 'checkin_id': cid})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>', methods=['DELETE'])
def api_checkin_delete(cid):
    """撤销打卡（返回）"""
    member_id = request.args.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        photos = conn.execute(
            'SELECT filename FROM photos WHERE checkin_id=?', (cid,)).fetchall()
        for p in photos:
            path = os.path.join(UPLOAD_DIR, p['filename'])
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
        conn.execute('DELETE FROM photos WHERE checkin_id=?', (cid,))
        conn.execute('DELETE FROM wrong_questions WHERE checkin_id=?', (cid,))
        conn.execute('DELETE FROM ai_runs WHERE checkin_id=?', (cid,))
        conn.execute('DELETE FROM review_actions WHERE checkin_id=?', (cid,))
        conn.execute('DELETE FROM checkins WHERE id=?', (cid,))
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>', methods=['PATCH'])
def api_checkin_patch(cid):
    """更新时长 / 备注"""
    data = request.get_json() or {}
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        duration = data.get('duration_min', ci['duration_min'])
        note = data.get('note', ci['note'])
        conn.execute(
            'UPDATE checkins SET duration_min=?, note=?, updated_at=? WHERE id=?',
            (duration, note, db.now_str(), cid))
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>/photos', methods=['POST'])
def api_upload_photos(cid):
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        files = request.files.getlist('files')
        saved = []
        for f in files:
            if not f or not f.filename:
                continue
            if not allowed_file(f.filename):
                continue
            ext = f.filename.rsplit('.', 1)[1].lower()
            fname = f'{uuid.uuid4().hex}.{ext}'
            f.save(os.path.join(UPLOAD_DIR, fname))
            conn.execute(
                'INSERT INTO photos (checkin_id, filename, original_name, uploaded_at) '
                'VALUES (?,?,?,?)', (cid, fname, f.filename, db.now_str()))
            saved.append(fname)
        conn.execute('UPDATE checkins SET status=?, updated_at=? WHERE id=?',
                     ('pending_ai', db.now_str(), cid))
        conn.commit()
        return jsonify({'ok': True, 'uploaded': len(saved)})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>/skip', methods=['POST'])
def api_skip(cid):
    """标记「今日无此任务」（小孩主动点击表示今天没这项作业）"""
    data = request.get_json() or {}
    member = data.get('member_id') or 'dad'
    note = (data.get('note') or '').strip()
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        conn.execute(
            'UPDATE checkins SET status=?, note=?, updated_at=? WHERE id=?',
            ('skipped', note or '今日无此任务', db.now_str(), cid))
        log_action(conn, cid, None, member, 'skip', note)
        conn.commit()
        return jsonify({'ok': True, 'status': 'skipped'})
    finally:
        conn.close()


@app.route('/api/photo/<int:pid>', methods=['DELETE'])
def api_photo_delete(pid):
    conn = db.get_conn()
    try:
        p = conn.execute('SELECT * FROM photos WHERE id=?', (pid,)).fetchone()
        if not p:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        path = os.path.join(UPLOAD_DIR, p['filename'])
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
        conn.execute('DELETE FROM photos WHERE id=?', (pid,))
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>')
def api_checkin_detail(cid):
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        data = row2dict(ci)
        board = conn.execute('SELECT * FROM boards WHERE id=?', (ci['board_id'],)).fetchone()
        data['board'] = row2dict(board) if board else None
        data['member'] = row2dict(conn.execute(
            'SELECT * FROM members WHERE id=?', (ci['member_id'],)).fetchone() or
            {'id': ci['member_id'], 'name': ci['member_id']})
        data['photos'] = [row2dict(r) for r in conn.execute(
            'SELECT * FROM photos WHERE checkin_id=? ORDER BY id', (cid,)).fetchall()]
        runs = [row2dict(r) for r in conn.execute(
            'SELECT * FROM ai_runs WHERE checkin_id=? ORDER BY version DESC',
            (cid,)).fetchall()]
        for r in runs:
            r['questions'] = [row2dict(q) for q in conn.execute(
                'SELECT * FROM wrong_questions WHERE run_id=? ORDER BY sort_order, id',
                (r['id'],)).fetchall()]
        data['runs'] = runs
        data['actions'] = [row2dict(a) for a in conn.execute(
            'SELECT * FROM review_actions WHERE checkin_id=? ORDER BY id DESC',
            (cid,)).fetchall()]
        return jsonify({'ok': True, 'checkin': data})
    finally:
        conn.close()


# ---------------- AI 识别回填（供外部 AI 调用） ----------------

@app.route('/api/pending-ai')
def api_pending_ai():
    """列出待 AI 识别的打卡（含照片地址），供 AI 拉取"""
    conn = db.get_conn()
    try:
        rows = conn.execute('''
            SELECT c.*, b.subject, b.name AS board_name, b.track_mode
            FROM checkins c JOIN boards b ON c.board_id=b.id
            WHERE c.status IN ('pending_ai','rerun_requested')
            ORDER BY c.checkin_date DESC, c.id DESC LIMIT 50
        ''').fetchall()
        out = []
        for r in rows:
            item = row2dict(r)
            item['photos'] = [row2dict(p) for p in conn.execute(
                'SELECT * FROM photos WHERE checkin_id=?', (r['id'],)).fetchall()]
            for p in item['photos']:
                p['url'] = f"/uploads/{p['filename']}"
            last_run = conn.execute(
                'SELECT * FROM ai_runs WHERE checkin_id=? ORDER BY version DESC LIMIT 1',
                (r['id'],)).fetchone()
            item['last_run'] = row2dict(last_run) if last_run else None
            item['last_comment'] = None
            if item['status'] == 'rerun_requested':
                act = conn.execute('''
                    SELECT * FROM review_actions WHERE checkin_id=? AND action='request_rerun'
                    ORDER BY id DESC LIMIT 1''', (r['id'],)).fetchone()
                item['last_comment'] = act['comment'] if act else None
            out.append(item)
        return jsonify({'ok': True, 'items': out})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>/ai-result', methods=['POST'])
def api_ai_result(cid):
    """AI 回填识别结果。
    body: { operator, summary, questions: [{content, student_answer, correct_answer,
            error_type, knowledge_point, confidence}] }
    """
    data = request.get_json() or {}
    operator = data.get('operator') or 'ai'
    summary = data.get('summary') or ''
    questions = data.get('questions') or []

    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        board = conn.execute('SELECT * FROM boards WHERE id=?', (ci['board_id'],)).fetchone()
        # 对语文/英语自动补拼音
        if board:
            questions = auto_pinyin_questions(conn, questions, board['subject'])

        run = get_or_create_run(conn, cid)
        # 清空该 run 旧错题（同版本重填）
        conn.execute('DELETE FROM wrong_questions WHERE run_id=?', (run['id'],))
        for i, q in enumerate(questions, 1):
            conn.execute(
                'INSERT INTO wrong_questions (run_id, checkin_id, content, student_answer, '
                'correct_answer, error_type, knowledge_point, confidence, status, sort_order) '
                'VALUES (?,?,?,?,?,?,?,?,?,?)',
                (run['id'], cid, q.get('content', ''), q.get('student_answer'),
                 q.get('correct_answer'), q.get('error_type'),
                 q.get('knowledge_point'), q.get('confidence', 1.0), 'pending', i))

        new_status = 'pending_review' if questions else 'confirmed'
        conn.execute(
            'UPDATE ai_runs SET status=?, summary=?, operator=?, created_at=? WHERE id=?',
            ('done', summary, operator, db.now_str(), run['id']))
        conn.execute(
            'UPDATE checkins SET status=?, current_run_id=?, updated_at=? WHERE id=?',
            (new_status, run['id'], db.now_str(), cid))
        log_action(conn, cid, run['id'], operator, 'ai_result',
                   f'v{run["version"]} 识别完成，错题 {len(questions)} 条')
        conn.commit()
        return jsonify({'ok': True, 'run_id': run['id'],
                        'version': run['version'], 'status': new_status})
    finally:
        conn.close()


# ---------------- 审核 / 重跑 / 流转 ----------------

@app.route('/api/question/<int:qid>/review', methods=['POST'])
def api_review_question(qid):
    """审核单条错题：confirm / reject"""
    data = request.get_json() or {}
    action = data.get('action')  # confirm | reject
    comment = data.get('comment') or ''
    reviewer = data.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        q = conn.execute('SELECT * FROM wrong_questions WHERE id=?', (qid,)).fetchone()
        if not q:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        status = 'confirmed' if action == 'confirm' else 'rejected'
        conn.execute(
            "UPDATE wrong_questions SET status=?, review_comment=?, reviewer_id=?, reviewed_at=? "
            "WHERE id=?", (status, comment, reviewer, db.now_str(), qid))
        log_action(conn, q['checkin_id'], q['run_id'], reviewer,
                   f'question_{action}', comment)
        conn.commit()
        return jsonify({'ok': True, 'status': status})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>/finalize', methods=['POST'])
def api_finalize(cid):
    """审核完成：全部处理完 → confirmed；若有驳回且填了意见 → 标记需重跑但不自动改状态"""
    data = request.get_json() or {}
    member = data.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        run = conn.execute(
            'SELECT * FROM ai_runs WHERE checkin_id=? ORDER BY version DESC LIMIT 1',
            (cid,)).fetchone()
        pending = 0
        if run:
            pending = conn.execute(
                "SELECT COUNT(*) AS c FROM wrong_questions WHERE run_id=? AND status='pending'",
                (run['id'],)).fetchone()['c']
        if pending > 0:
            return jsonify({'ok': False, 'error': f'还有 {pending} 条未审核'}), 400
        conn.execute('UPDATE checkins SET status=?, updated_at=? WHERE id=?',
                     ('confirmed', db.now_str(), cid))
        # 错题入库时自动建复习计划
        if run:
            board = conn.execute(
                'SELECT b.* FROM boards b JOIN checkins c ON c.board_id=b.id WHERE c.id=?',
                (cid,)).fetchone()
            for q in conn.execute(
                    "SELECT id FROM wrong_questions WHERE run_id=? AND status='confirmed'",
                    (run['id'],)).fetchall():
                schedule_initial_review(conn, q['id'], board['subject'])
        log_action(conn, cid, run['id'] if run else None, member,
                   'finalize', '审核完成，错题入库')
        conn.commit()
        return jsonify({'ok': True, 'status': 'confirmed'})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>/request-rerun', methods=['POST'])
def api_request_rerun(cid):
    """人工填写意见 → 打回任务栏重新调用 LLM 重跑"""
    data = request.get_json() or {}
    comment = (data.get('comment') or '').strip()
    member = data.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        # 归档当前版本错题，开新版本
        max_ver = conn.execute(
            'SELECT COALESCE(MAX(version),0) AS m FROM ai_runs WHERE checkin_id=?',
            (cid,)).fetchone()['m']
        cur = conn.execute(
            'INSERT INTO ai_runs (checkin_id, version, status, comment, created_at) '
            'VALUES (?,?,?,?,?)', (cid, max_ver + 1, 'pending', comment, db.now_str()))
        new_run_id = cur.lastrowid
        conn.execute('UPDATE checkins SET status=?, current_run_id=?, updated_at=? WHERE id=?',
                     ('rerun_requested', new_run_id, db.now_str(), cid))
        log_action(conn, cid, new_run_id, member, 'request_rerun', comment)
        conn.commit()
        return jsonify({'ok': True, 'run_id': new_run_id,
                        'version': max_ver + 1, 'status': 'rerun_requested'})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>/transfer', methods=['POST'])
def api_transfer(cid):
    """流转给指定成员处理"""
    data = request.get_json() or {}
    to_member = data.get('to_member_id') or 'mom'
    comment = (data.get('comment') or '').strip()
    member = data.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        conn.execute('UPDATE checkins SET status=?, updated_at=? WHERE id=?',
                     ('transferred', db.now_str(), cid))
        log_action(conn, cid, None, member, 'transfer', comment, to_member)
        conn.commit()
        return jsonify({'ok': True, 'status': 'transferred', 'to': to_member})
    finally:
        conn.close()


@app.route('/api/question/<int:qid>/undo-review', methods=['POST'])
def api_question_undo_review(qid):
    """错题审核撤销：把 confirmed/rejected 退回 pending；如果是 finalize 后撤回到 pending_review"""
    data = request.get_json() or {}
    member = data.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        q = conn.execute('SELECT * FROM wrong_questions WHERE id=?', (qid,)).fetchone()
        if not q:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        if q['status'] == 'pending':
            return jsonify({'ok': False, 'error': '已经是待审状态'}), 400
        conn.execute('UPDATE wrong_questions SET status=?, review_comment=NULL, '
                     'reviewer_id=NULL, reviewed_at=NULL WHERE id=?',
                     ('pending', qid))
        # 如果 checkin 已是 confirmed，回退到 pending_review（因为有题在审）
        conn.execute("UPDATE checkins SET status='pending_review', updated_at=? "
                     "WHERE id=? AND status='confirmed'",
                     (db.now_str(), q['checkin_id']))
        log_action(conn, q['checkin_id'], q['run_id'], member, 'undo_review',
                   f'撤回错题 #{qid} 的审核')
        conn.commit()
        return jsonify({'ok': True, 'status': 'pending'})
    finally:
        conn.close()


# ---------------- 任务级"撤回最近一个动作" ----------------

_ACTION_UNDO_HANDLERS = {}  # 注册用


def register_undo(action, handler):
    _ACTION_UNDO_HANDLERS[action] = handler


# finalize 撤回：confirmed → pending_review（保留错题，仅改 checkin 状态）
def _undo_finalize(conn, ci):
    if ci['status'] != 'confirmed':
        return False, '只有已入库的任务能撤回到审核中'
    conn.execute("UPDATE checkins SET status='pending_review', updated_at=? WHERE id=?",
                 (db.now_str(), ci['id']))
    return True, '已退回到「待审核」'


# request_rerun 撤回：rerun_requested → 上一个状态（pending_review 或 pending_ai）
def _undo_rerun(conn, ci):
    if ci['status'] != 'rerun_requested':
        return False, '当前不是打回状态'
    # 看上上一步是什么
    last_done_run = conn.execute(
        "SELECT * FROM ai_runs WHERE checkin_id=? AND status='done' "
        "ORDER BY version DESC LIMIT 1", (ci['id'],)).fetchone()
    new_status = 'pending_review' if last_done_run else 'pending_ai'
    conn.execute("UPDATE checkins SET status=?, updated_at=? WHERE id=?",
                 (new_status, db.now_str(), ci['id']))
    # 同时把刚建出来的 pending 新 run 删掉
    cur = conn.execute(
        "SELECT * FROM ai_runs WHERE checkin_id=? AND status='pending' "
        "ORDER BY version DESC LIMIT 1", (ci['id'],)).fetchone()
    if cur:
        conn.execute('DELETE FROM ai_runs WHERE id=?', (cur['id'],))
    return True, '已撤回打回'


# transfer 撤回：transferred → pending_review
def _undo_transfer(conn, ci):
    if ci['status'] != 'transferred':
        return False, '当前不是流转状态'
    conn.execute("UPDATE checkins SET status='pending_review', updated_at=? WHERE id=?",
                 (db.now_str(), ci['id']))
    return True, '已撤回流转'


# take_back 撤回：撤销一次接手，回到 transferred
def _undo_take_back(conn, ci):
    if ci['status'] != 'pending_review':
        return False, '当前不在审核中，无法撤回到流转'
    conn.execute("UPDATE checkins SET status='transferred', updated_at=? WHERE id=?",
                 (db.now_str(), ci['id']))
    return True, '已撤回到流转中'


register_undo('finalize', _undo_finalize)
register_undo('request_rerun', _undo_rerun)
register_undo('transfer', _undo_transfer)
register_undo('take_back', _undo_take_back)


@app.route('/api/checkin/<int:cid>/undo-action', methods=['POST'])
def api_checkin_undo_action(cid):
    """通用撤回：撤销 review_actions 里最后一条可撤回动作"""
    data = request.get_json() or {}
    member = data.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        last = conn.execute(
            'SELECT * FROM review_actions WHERE checkin_id=? '
            'AND action IN (?,?,?,?) ORDER BY id DESC LIMIT 1',
            (cid, 'finalize', 'request_rerun', 'transfer', 'take_back')).fetchone()
        if not last:
            return jsonify({'ok': False, 'error': '没有可撤回的动作'}), 400
        handler = _ACTION_UNDO_HANDLERS.get(last['action'])
        if not handler:
            return jsonify({'ok': False, 'error': f'动作 {last["action"]} 暂不支持撤回'}), 400
        ok, msg = handler(conn, ci)
        if not ok:
            return jsonify({'ok': False, 'error': msg}), 400
        log_action(conn, cid, None, member, f'undo_{last["action"]}', f'撤回 {last["action"]}')
        conn.commit()
        return jsonify({'ok': True, 'message': msg, 'undone': last['action']})
    finally:
        conn.close()


@app.route('/api/checkin/<int:cid>/take-back', methods=['POST'])
def api_take_back(cid):
    """接手/取回：把流转中的任务拿回到自己名下并进入审核"""
    data = request.get_json() or {}
    member = data.get('member_id') or 'mom'
    conn = db.get_conn()
    try:
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (cid,)).fetchone()
        if not ci:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        run = conn.execute(
            'SELECT * FROM ai_runs WHERE checkin_id=? ORDER BY version DESC LIMIT 1',
            (cid,)).fetchone()
        new_status = 'pending_review' if run and run['status'] == 'done' else ci['status']
        conn.execute('UPDATE checkins SET status=?, updated_at=? WHERE id=?',
                     (new_status, db.now_str(), cid))
        log_action(conn, cid, run['id'] if run else None, member, 'take_back', None)
        conn.commit()
        return jsonify({'ok': True, 'status': new_status})
    finally:
        conn.close()


# ---------------- 知识点管理 ----------------

@app.route('/api/knowledge-heatmap')
def api_knowledge_heatmap():
    """知识点热力图：按板块 × 知识点聚合错题量 + 复习状态
    返回：{
      subjects: [{subject, boards: [{board_id, board_name, kps: [{name, total, due, learning, mastered, error_types: {}}]}]}],
      totals: {total, mastered, due, learning, by_subject: {}}
    }
    """
    conn = db.get_conn()
    try:
        boards = [row2dict(r) for r in conn.execute(
            'SELECT * FROM boards ORDER BY subject, sort_order').fetchall()]
        kps = [row2dict(r) for r in conn.execute(
            'SELECT * FROM knowledge_points ORDER BY sort_order').fetchall()]
        kp_by_board = {}
        for k in kps:
            kp_by_board.setdefault(k['board_id'], []).append(k)

        # 错题 + 复习状态（取每个错题的最新状态）
        wrong = [row2dict(r) for r in conn.execute('''
            SELECT q.id, q.error_type, q.knowledge_point, q.checkin_id,
                   q.status AS q_status, c.checkin_date, c.board_id,
                   s.status AS review_status,
                   COALESCE(rr.max_stages, 4) AS max_stages
            FROM wrong_questions q
            JOIN checkins c ON q.checkin_id = c.id
            JOIN boards b ON c.board_id = b.id
            JOIN ai_runs r ON q.run_id = r.id
            JOIN (SELECT checkin_id, MAX(version) AS mv
                  FROM ai_runs WHERE status='done' GROUP BY checkin_id) lr
              ON lr.checkin_id = c.id AND lr.mv = r.version
            LEFT JOIN review_schedules s ON s.wrong_question_id = q.id
            LEFT JOIN review_rules rr ON rr.subject = b.subject
            WHERE q.status='confirmed'
        ''').fetchall()]

        today = db.today_str()
        def state_of(w):
            if w['review_status'] == 'mastered':
                return 'mastered'
            if w['review_status'] == 'pending' and w.get('next_review_date'):
                # 由 next_review_date <= today → due
                pass
            return 'learning'  # 占位，下面按 next 校正
        # 校正状态
        schedules = {r['wrong_question_id']: dict(r) for r in conn.execute(
            'SELECT * FROM review_schedules').fetchall()}

        from collections import defaultdict
        by_kp = defaultdict(lambda: {'total': 0, 'due': 0, 'learning': 0,
                                      'mastered': 0, 'error_types': defaultdict(int),
                                      'wrong_ids': []})
        for w in wrong:
            bk = (w['board_id'], w['knowledge_point'] or '未归类')
            by_kp[bk]['total'] += 1
            et = w['error_type'] or '未标注'
            by_kp[bk]['error_types'][et] += 1
            by_kp[bk]['wrong_ids'].append(w['id'])
            sch = schedules.get(w['id'])
            if sch and sch['status'] == 'mastered':
                by_kp[bk]['mastered'] += 1
            elif sch and sch['status'] == 'pending':
                if sch['next_review_date'] and sch['next_review_date'] <= today:
                    by_kp[bk]['due'] += 1
                else:
                    by_kp[bk]['learning'] += 1
            else:
                by_kp[bk]['learning'] += 1

        # 按科目归组
        subj_map = {}
        for b in boards:
            sb = b['subject']
            subj_map.setdefault(sb, {'subject': sb, 'boards': []})
            kp_items = []
            for k in kp_by_board.get(b['id'], []):
                data = by_kp.get((b['id'], k['name']),
                                 {'total': 0, 'due': 0, 'learning': 0,
                                  'mastered': 0, 'error_types': {}})
                kp_items.append({
                    'kp_id': k['id'], 'name': k['name'], 'active': k.get('active', 1),
                    **data, 'error_types': dict(data['error_types']),
                })
            # 也包含未归类（错题选了"未指定"或根本无 kp）
            ungrouped = by_kp.get((b['id'], '未归类'))
            if ungrouped and ungrouped['total']:
                kp_items.append({
                    'kp_id': None, 'name': '未归类', 'active': 1, **ungrouped,
                    'error_types': dict(ungrouped['error_types']),
                })
            subj_map[sb]['boards'].append({
                'board_id': b['id'], 'board_name': b['name'],
                'org_type': b['org_type'], 'track_mode': b['track_mode'],
                'kps': kp_items,
            })

        # 汇总
        totals = {'total': 0, 'due': 0, 'learning': 0, 'mastered': 0,
                  'by_subject': {}}
        for s in subj_map.values():
            sub_t = {'total': 0, 'due': 0, 'learning': 0, 'mastered': 0,
                     'weakest_kp': None, 'weakest_count': 0}
            for b in s['boards']:
                for k in b['kps']:
                    sub_t['total'] += k['total']
                    sub_t['due'] += k['due']
                    sub_t['learning'] += k['learning']
                    sub_t['mastered'] += k['mastered']
                    if k['total'] > sub_t['weakest_count']:
                        sub_t['weakest_count'] = k['total']
                        sub_t['weakest_kp'] = f"{b['board_name']}·{k['name']}"
            totals['by_subject'][s['subject']] = sub_t
            totals['total'] += sub_t['total']
            totals['due'] += sub_t['due']
            totals['learning'] += sub_t['learning']
            totals['mastered'] += sub_t['mastered']

        return jsonify({
            'ok': True,
            'subjects': list(subj_map.values()),
            'totals': totals,
        })
    finally:
        conn.close()


@app.route('/api/study-plan')
def api_study_plan():
    """学习计划建议：
    - 找出薄弱知识点（due 最多 + 错题数最多）
    - 结合今天待复习 + 未来 7 天待复习
    - 期末前倒推：检查 checkin 表里本学期最后日期，生成每日学习清单
    """
    conn = db.get_conn()
    try:
        today = db.today_str()
        # 1) 待复习题（未来 7 天）
        rows = conn.execute('''
            SELECT s.id, s.current_stage, s.next_review_date, s.status,
                   q.content, q.error_type, q.knowledge_point, q.checkin_id,
                   c.checkin_date, c.board_id, b.subject, b.name AS board_name
            FROM review_schedules s
            JOIN wrong_questions q ON s.wrong_question_id = q.id
            JOIN checkins c ON q.checkin_id = c.id
            JOIN boards b ON c.board_id = b.id
            WHERE s.status='pending' AND s.next_review_date IS NOT NULL
            ORDER BY s.next_review_date ASC, s.id ASC
        ''').fetchall()
        schedule = [dict(r) for r in rows]

        # 按日期分组
        from collections import defaultdict
        by_date = defaultdict(list)
        for s in schedule:
            by_date[s['next_review_date']].append(s)

        # 2) 找出每个科目最薄弱的知识点
        hm = conn.execute('''
            SELECT b.subject, b.name AS board_name, q.knowledge_point,
                   COUNT(*) AS cnt, c.board_id
            FROM wrong_questions q
            JOIN checkins c ON q.checkin_id = c.id
            JOIN boards b ON c.board_id = b.id
            WHERE q.status='confirmed'
              AND q.knowledge_point IS NOT NULL AND q.knowledge_point != ''
            GROUP BY b.subject, b.name, q.knowledge_point
            ORDER BY cnt DESC LIMIT 8
        ''').fetchall()
        weak_points = [dict(r) for r in hm]

        # 3) 本学期最后一次打卡
        last_ci = conn.execute(
            'SELECT MAX(checkin_date) AS d FROM checkins').fetchone()
        last_date = last_ci['d'] if last_ci else None

        # 4) 生成未来 7 天计划
        from datetime import datetime, timedelta
        plan = []
        for offset in range(7):
            d = (datetime.now() + timedelta(days=offset)).strftime('%Y-%m-%d')
            due = by_date.get(d, [])
            tip = ''
            if d == today:
                tip = '今天'
            elif offset == 1:
                tip = '明天'
            else:
                tip = f'{offset} 天后'
            plan.append({
                'date': d, 'tip': tip,
                'count': len(due),
                'items': [{'board': i['board_name'], 'subject': i['subject'],
                           'content': i['content'][:24],
                           'kp': i['knowledge_point']} for i in due[:8]],
            })

        return jsonify({
            'ok': True,
            'plan': plan,
            'weak_points': weak_points,
            'last_checkin_date': last_date,
            'total_pending': len(schedule),
        })
    finally:
        conn.close()


@app.route('/api/board/<board_id>/knowledge-points', methods=['GET', 'POST'])
def api_knowledge_points(board_id):
    conn = db.get_conn()
    try:
        if request.method == 'GET':
            rows = [row2dict(r) for r in conn.execute(
                'SELECT * FROM knowledge_points WHERE board_id=? ORDER BY sort_order',
                (board_id,)).fetchall()]
            return jsonify({'ok': True, 'items': rows})

        data = request.get_json() or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'ok': False, 'error': 'name required'}), 400
        mx = conn.execute(
            'SELECT COALESCE(MAX(sort_order),0) AS m FROM knowledge_points WHERE board_id=?',
            (board_id,)).fetchone()['m']
        exists = conn.execute(
            'SELECT 1 FROM knowledge_points WHERE board_id=? AND name=?',
            (board_id, name)).fetchone()
        if exists:
            return jsonify({'ok': False, 'error': '已存在'}), 409
        cur = conn.execute(
            'INSERT INTO knowledge_points (board_id, name, sort_order) VALUES (?,?,?)',
            (board_id, name, mx + 1))
        conn.commit()
        return jsonify({'ok': True, 'id': cur.lastrowid})
    finally:
        conn.close()


@app.route('/api/knowledge-point/<int:kid>', methods=['DELETE', 'PATCH'])
def api_knowledge_point(kid):
    conn = db.get_conn()
    try:
        if request.method == 'DELETE':
            conn.execute('DELETE FROM knowledge_points WHERE id=?', (kid,))
            conn.commit()
            return jsonify({'ok': True})
        data = request.get_json() or {}
        name = data.get('name')
        if name:
            conn.execute('UPDATE knowledge_points SET name=? WHERE id=?', (name.strip(), kid))
        if 'active' in data:
            conn.execute('UPDATE knowledge_points SET active=? WHERE id=?',
                         (1 if data['active'] else 0, kid))
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


# ---------------- 历史 / 统计 ----------------

@app.route('/api/board/<board_id>/history')
def api_board_history(board_id):
    conn = db.get_conn()
    try:
        rows = conn.execute('''
            SELECT c.*, (SELECT COUNT(*) FROM photos p WHERE p.checkin_id=c.id) AS photo_count
            FROM checkins c WHERE c.board_id=?
            ORDER BY c.checkin_date DESC LIMIT 60
        ''', (board_id,)).fetchall()
        out = []
        for r in rows:
            item = row2dict(r)
            run = conn.execute(
                'SELECT * FROM ai_runs WHERE checkin_id=? ORDER BY version DESC LIMIT 1',
                (r['id'],)).fetchone()
            if run:
                item['version'] = run['version']
                item['summary'] = run['summary']
                item['wrong_count'] = conn.execute(
                    "SELECT COUNT(*) AS c FROM wrong_questions WHERE run_id=? AND status='confirmed'",
                    (run['id'],)).fetchone()['c']
            else:
                item['version'] = None
                item['summary'] = None
                item['wrong_count'] = 0
            out.append(item)
        return jsonify({'ok': True, 'items': out})
    finally:
        conn.close()


@app.route('/api/wrong-questions')
def api_wrong_questions():
    """错题本：已确认的错题，可按科目/板块筛选"""
    subject = request.args.get('subject')
    conn = db.get_conn()
    try:
        # 只取每个打卡「最新已完成版本」的错题，避免重跑后新旧版本重复入库
        sql = '''
            SELECT q.*, c.checkin_date, c.board_id, b.subject, b.name AS board_name,
                   r.version,
                   s.id AS schedule_id, s.current_stage, s.next_review_date,
                   s.status AS review_status, s.history AS review_history,
                   COALESCE(rr.max_stages, 4) AS max_stages
            FROM wrong_questions q
            JOIN checkins c ON q.checkin_id = c.id
            JOIN boards b ON c.board_id = b.id
            JOIN ai_runs r ON q.run_id = r.id
            JOIN (SELECT checkin_id, MAX(version) AS mv
                  FROM ai_runs WHERE status='done' GROUP BY checkin_id) lr
              ON lr.checkin_id = c.id AND lr.mv = r.version
            LEFT JOIN review_schedules s ON s.wrong_question_id = q.id
            LEFT JOIN review_rules rr ON rr.subject = b.subject
            WHERE q.status='confirmed'
        '''
        params = []
        if subject:
            sql += ' AND b.subject=?'
            params.append(subject)
        sql += ' ORDER BY c.checkin_date DESC, q.id DESC LIMIT 500'
        rows = [row2dict(r) for r in conn.execute(sql, params).fetchall()]

        today = db.today_str()
        for it in rows:
            hist = []
            try:
                hist = json.loads(it.pop('review_history') or '[]')
            except Exception:
                hist = []
            it['review_times'] = len(hist)                       # 已复习次数
            it['wrong_times'] = sum(1 for h in hist if h.get('result') == 'wrong')
            if it.get('review_status') == 'mastered':
                it['review_state'] = 'mastered'
            elif it.get('next_review_date') and it['next_review_date'] <= today:
                it['review_state'] = 'due'
            elif it.get('next_review_date'):
                it['review_state'] = 'learning'
            else:
                it['review_state'] = 'new'
            it['history'] = hist

        # 汇总：用于错题本「本阶段错误全景」
        def _count(pred):
            return sum(1 for x in rows if pred(x))

        by_subject, by_kp, by_state, by_error = {}, {}, {}, {}
        for x in rows:
            by_subject[x['subject']] = by_subject.get(x['subject'], 0) + 1
            key = x.get('knowledge_point') or '未归类'
            by_kp.setdefault(x['subject'], {})
            by_kp[x['subject']][key] = by_kp[x['subject']].get(key, 0) + 1
            by_state[x['review_state']] = by_state.get(x['review_state'], 0) + 1
            et = x.get('error_type') or '未标注'
            by_error[et] = by_error.get(et, 0) + 1

        summary = {
            'total': len(rows),
            'by_subject': by_subject,
            'by_knowledge_point': by_kp,
            'by_state': {
                'due': _count(lambda x: x['review_state'] == 'due'),
                'learning': _count(lambda x: x['review_state'] == 'learning'),
                'mastered': _count(lambda x: x['review_state'] == 'mastered'),
                'new': _count(lambda x: x['review_state'] == 'new'),
            },
            'by_error_type': by_error,
            'date_range': [rows[-1]['checkin_date'], rows[0]['checkin_date']] if rows else None,
        }
        return jsonify({'ok': True, 'items': rows, 'summary': summary})
    finally:
        conn.close()


# ---------------- 复习机制（间隔重复） ----------------

@app.route('/api/review/today-done')
def api_review_today_done():
    """今天已经复习过的题（无论对错），按时间倒序"""
    today = db.today_str()
    conn = db.get_conn()
    try:
        # 用 json_each 解析 history JSON
        rows = conn.execute('''
            SELECT s.id, s.current_stage, s.next_review_date, s.status, s.history,
                   q.content, q.student_answer, q.correct_answer, q.error_type,
                   q.knowledge_point, q.checkin_id, c.checkin_date, c.board_id,
                   b.subject, b.name AS board_name
            FROM review_schedules s
            JOIN wrong_questions q ON s.wrong_question_id = q.id
            JOIN checkins c ON q.checkin_id = c.id
            JOIN boards b ON c.board_id = b.id
            WHERE EXISTS (
              SELECT 1 FROM json_each(s.history) je
              WHERE je.value->>'date' = ?
            )
            ORDER BY s.id DESC LIMIT 50
        ''', (today,)).fetchall()
        items = [row2dict(r) for r in rows]
        for it in items:
            it['history'] = json.loads(it['history'] or '[]')
            # 提取今天那条记录
            today_rec = [h for h in it['history'] if h.get('date') == today]
            it['today_records'] = today_rec
        return jsonify({'ok': True, 'items': items, 'today': today})
    finally:
        conn.close()


@app.route('/api/review/today')
def api_review_today():
    """今天 + 之前欠的待复习错题"""
    subject = request.args.get('subject')
    conn = db.get_conn()
    try:
        today = db.today_str()
        sql = '''
            SELECT s.*, q.content, q.student_answer, q.correct_answer, q.error_type,
                   q.knowledge_point, q.confidence, q.checkin_id,
                   c.checkin_date, c.board_id, b.subject, b.name AS board_name, b.track_mode
            FROM review_schedules s
            JOIN wrong_questions q ON s.wrong_question_id = q.id
            JOIN checkins c ON q.checkin_id = c.id
            JOIN boards b ON c.board_id = b.id
            WHERE s.status='pending' AND s.next_review_date <= ?
        '''
        params = [today]
        if subject:
            sql += ' AND b.subject=?'
            params.append(subject)
        sql += ' ORDER BY s.next_review_date ASC, q.id ASC LIMIT 200'
        items = [row2dict(r) for r in conn.execute(sql, params).fetchall()]
        for it in items:
            it['history'] = json.loads(it['history'] or '[]')
            it['overdue_days'] = (
                (datetime.now() - datetime.strptime(it['next_review_date'], '%Y-%m-%d')).days
            )
        return jsonify({'ok': True, 'items': items, 'today': today})
    finally:
        conn.close()


@app.route('/api/review/mastered')
def api_review_mastered():
    """已掌握的错题"""
    subject = request.args.get('subject')
    conn = db.get_conn()
    try:
        sql = '''
            SELECT s.*, q.content, q.student_answer, q.correct_answer, q.error_type,
                   q.knowledge_point, q.checkin_date, c.board_id,
                   b.subject, b.name AS board_name
            FROM review_schedules s
            JOIN wrong_questions q ON s.wrong_question_id = q.id
            JOIN checkins c ON q.checkin_id = c.id
            JOIN boards b ON c.board_id = b.id
            WHERE s.status='mastered'
        '''
        params = []
        if subject:
            sql += ' AND b.subject=?'
            params.append(subject)
        sql += ' ORDER BY s.id DESC LIMIT 200'
        items = [row2dict(r) for r in conn.execute(sql, params).fetchall()]
        for it in items:
            it['history'] = json.loads(it['history'] or '[]')
        return jsonify({'ok': True, 'items': items})
    finally:
        conn.close()


@app.route('/api/review/<int:rid>/answer', methods=['POST'])
def api_review_answer(rid):
    """提交复习答题结果：correct / wrong"""
    data = request.get_json() or {}
    result = data.get('result')  # correct | wrong
    member = data.get('member_id') or 'dad'
    if result not in ('correct', 'wrong'):
        return jsonify({'ok': False, 'error': 'result must be correct or wrong'}), 400
    conn = db.get_conn()
    try:
        sch = conn.execute(
            'SELECT * FROM review_schedules WHERE id=?', (rid,)).fetchone()
        if not sch:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        wq = conn.execute(
            'SELECT * FROM wrong_questions WHERE id=?', (sch['wrong_question_id'],)).fetchone()
        if not wq:
            return jsonify({'ok': False, 'error': 'wrong_question missing'}), 404
        advance_result = advance_schedule(conn, rid, result)
        log_action(conn, wq['checkin_id'], None, member,
                   f'review_{result}', f'第{sch["current_stage"]+1}次复习{result}')
        conn.commit()
        return jsonify({
            'ok': True, 'result': result,
            'new_stage': advance_result['new_stage'],
            'new_status': advance_result['new_status'],
            'next_review_date': advance_result['next_review_date'],
        })
    finally:
        conn.close()


@app.route('/api/review/<int:rid>/undo', methods=['POST'])
def api_review_undo(rid):
    """撤销最近一次复习答题：把 history 末尾那条删掉，回滚 stage/next/状态"""
    data = request.get_json() or {}
    member = data.get('member_id') or 'dad'
    conn = db.get_conn()
    try:
        sch = conn.execute('SELECT * FROM review_schedules WHERE id=?', (rid,)).fetchone()
        if not sch:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        history = json.loads(sch['history'] or '[]')
        if not history:
            return jsonify({'ok': False, 'error': 'no record to undo'}), 400
        history.pop()
        wq = conn.execute(
            'SELECT * FROM wrong_questions WHERE id=?', (sch['wrong_question_id'],)).fetchone()
        ci = conn.execute('SELECT * FROM checkins WHERE id=?', (wq['checkin_id'],)).fetchone()
        board = conn.execute('SELECT * FROM boards WHERE id=?', (ci['board_id'],)).fetchone()
        rule = get_review_rule(conn, board['subject'])

        # 还原：撤销后回到上一次的"未答题"状态
        # 取 history 倒数第二条的 stage 作为 current_stage，没有则 0
        prev_stage = history[-1]['stage'] - 1 if history else 0
        if prev_stage < 0: prev_stage = 0
        if prev_stage >= rule['max_stages']:
            new_status, next_date = 'mastered', None
        else:
            new_status = 'pending'
            intervals = rule['intervals']
            interval = intervals[prev_stage] if prev_stage < len(intervals) else 30
            next_date = (datetime.now() + timedelta(days=interval)).strftime('%Y-%m-%d')
        conn.execute(
            'UPDATE review_schedules SET current_stage=?, next_review_date=?, history=?, status=? WHERE id=?',
            (prev_stage, next_date, json.dumps(history, ensure_ascii=False), new_status, rid))
        log_action(conn, wq['checkin_id'], None, member, 'review_undo', '撤销复习答题')
        conn.commit()
        return jsonify({'ok': True, 'new_stage': prev_stage, 'new_status': new_status,
                        'next_review_date': next_date})
    finally:
        conn.close()


@app.route('/api/review/stats')
def api_review_stats():
    """复习统计：待复习/已掌握/总错题"""
    conn = db.get_conn()
    try:
        today = db.today_str()
        due = conn.execute(
            "SELECT COUNT(*) AS c FROM review_schedules WHERE status='pending' "
            "AND next_review_date <= ?", (today,)).fetchone()['c']
        upcoming = conn.execute(
            "SELECT COUNT(*) AS c FROM review_schedules WHERE status='pending' "
            "AND next_review_date > ?", (today,)).fetchone()['c']
        mastered = conn.execute(
            "SELECT COUNT(*) AS c FROM review_schedules WHERE status='mastered'").fetchone()['c']
        total_wrong = conn.execute(
            "SELECT COUNT(*) AS c FROM wrong_questions WHERE status='confirmed'").fetchone()['c']
        per_subject = {}
        for r in conn.execute('''
            SELECT b.subject,
              SUM(CASE WHEN s.status='pending' AND s.next_review_date<=? THEN 1 ELSE 0 END) AS due,
              SUM(CASE WHEN s.status='pending' AND s.next_review_date>? THEN 1 ELSE 0 END) AS upcoming,
              SUM(CASE WHEN s.status='mastered' THEN 1 ELSE 0 END) AS mastered
            FROM review_schedules s
            JOIN wrong_questions q ON s.wrong_question_id=q.id
            JOIN checkins c ON q.checkin_id=c.id
            JOIN boards b ON c.board_id=b.id
            GROUP BY b.subject
        ''', (today, today)).fetchall():
            per_subject[r['subject']] = {
                'due': r['due'], 'upcoming': r['upcoming'], 'mastered': r['mastered'],
            }
        return jsonify({
            'ok': True,
            'due': due, 'upcoming': upcoming,
            'mastered': mastered, 'total_wrong': total_wrong,
            'per_subject': per_subject,
        })
    finally:
        conn.close()


if __name__ == '__main__':
    db.init_db()
    port = int(os.environ.get('PORT', 3000))
    app.run(host='0.0.0.0', port=port, debug=False)
