# -*- coding: utf-8 -*-
"""数据持久化护盾：让 deploy 不再清空用户数据。

背景
----
WorkBuddy 的 deploy 是「整目录替换」：把本地 kanban-app/ 压缩上传，
覆盖云端沙箱里的同名目录。而用户数据 instance/（kanban.db + uploads/）
就在这个目录里，所以每次 deploy 都会被清空，必须手动 backup → deploy → restore。

方案
----
把 instance/ 的快照 zip 写到**上传目录之外**的位置（kanban-app/ 的兄弟目录），
这个位置 deploy 不会碰。启动时如果发现 instance/ 为空，自动从快照恢复。

效果：deploy 后数据自动回来，不再需要人工 backup / restore。

安全原则
--------
* 只在 instance/ 为空（没有 kanban.db）时才恢复 —— 绝不覆盖已有数据。
* 快照写入用「临时文件 + 原子替换」，避免半截文件。
* 任何异常都只记日志，绝不因此让服务崩溃。
"""
import os
import time
import zipfile
import threading
import datetime

LOG = __import__('logging').getLogger('kanban.persist')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE_DIR)          # .../kanban-app


def _candidates():
    """候选持久化目录，按优先级排列：越靠前越可能在 deploy 中存活。"""
    c = []
    parent = os.path.dirname(REPO_ROOT)
    if parent and parent != REPO_ROOT:
        c.append(os.path.join(parent, 'kanban-persist'))     # 兄弟目录（推荐）
    home = os.path.expanduser('~')
    if home:
        c.append(os.path.join(home, 'kanban-persist'))
    c.append(os.path.join('/tmp', 'kanban-persist'))
    return c


def pick_dir():
    """挑选第一个可写目录。"""
    for d in _candidates():
        try:
            os.makedirs(d, exist_ok=True)
            probe = os.path.join(d, '.writable')
            with open(probe, 'w') as f:
                f.write('1')
            os.remove(probe)
            return d
        except Exception:
            continue
    return None


PERSIST_DIR = pick_dir()
SNAPSHOT = os.path.join(PERSIST_DIR, 'instance-snapshot.zip') if PERSIST_DIR else None
LAST_STATE = {'saved_at': None, 'restored_at': None, 'error': None}


def db_path(instance_dir):
    return os.path.join(instance_dir, 'data', 'kanban.db')


def has_data(instance_dir):
    """instance/ 里是否已有真实数据（有 db 且非空）。"""
    p = db_path(instance_dir)
    try:
        return os.path.isfile(p) and os.path.getsize(p) > 0
    except Exception:
        return False


def _fingerprint(instance_dir):
    """数据指纹：用于判断是否需要重新快照（避免无意义 IO）。"""
    try:
        p = db_path(instance_dir)
        st = os.stat(p)
        up = os.path.join(instance_dir, 'uploads')
        n = len(os.listdir(up)) if os.path.isdir(up) else 0
        return (int(st.st_mtime), st.st_size, n)
    except Exception:
        return (0, 0, 0)


def snapshot(instance_dir, dest=None):
    """把 instance/ 打成 zip 快照，原子写入。返回 (ok, msg)。"""
    dest = dest or SNAPSHOT
    if not dest:
        return False, '无可写持久化目录'
    if not os.path.isdir(instance_dir):
        return False, 'instance/ 不存在'
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + '.tmp'
        n = 0
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(instance_dir):
                for f in files:
                    fp = os.path.join(root, f)
                    try:
                        zf.write(fp, os.path.relpath(fp, instance_dir))
                        n += 1
                    except Exception:
                        continue
        if n == 0:
            os.remove(tmp)
            return False, 'instance/ 为空，跳过快照'
        os.replace(tmp, dest)
        LAST_STATE['saved_at'] = datetime.datetime.now().isoformat(timespec='seconds')
        LAST_STATE['error'] = None
        return True, f'{n} 个文件'
    except Exception as e:
        LAST_STATE['error'] = str(e)
        LOG.warning('[persist] snapshot failed: %s', e)
        return False, str(e)


def restore(instance_dir, src=None):
    """从快照恢复 instance/。仅在数据缺失时调用。返回 (ok, msg)。"""
    src = src or SNAPSHOT
    if not src or not os.path.isfile(src):
        return False, '无快照文件'
    try:
        bak = instance_dir + '.corrupt.' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        if os.path.isdir(instance_dir):
            os.rename(instance_dir, bak)
        os.makedirs(instance_dir, exist_ok=True)
        with zipfile.ZipFile(src) as zf:
            zf.extractall(instance_dir)
        if not has_data(instance_dir):
            # 恢复后仍无数据 → 回滚，绝不留下坏状态
            if os.path.isdir(bak):
                import shutil
                shutil.rmtree(instance_dir, ignore_errors=True)
                os.rename(bak, instance_dir)
            return False, '快照中没有有效数据库'
        import shutil
        shutil.rmtree(bak, ignore_errors=True)
        LAST_STATE['restored_at'] = datetime.datetime.now().isoformat(timespec='seconds')
        return True, '已从快照恢复'
    except Exception as e:
        LAST_STATE['error'] = str(e)
        LOG.warning('[persist] restore failed: %s', e)
        return False, str(e)


def _user_data_count(instance_dir):
    """统计用户数据条数（照片 + 打卡记录）。

    用于区分「真有数据」和「deploy 后 init_db 建出来的空库」。
    读不了时返回 -1（当作有数据，绝不冒险恢复）。
    """
    p = db_path(instance_dir)
    n = 0
    found = False
    try:
        import sqlite3
        con = sqlite3.connect(p)
        for t in ('photos', 'checkins'):
            try:
                n += int(con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0])
                found = True
            except Exception:
                continue
        con.close()
    except Exception:
        return -1
    return n if found else -1


def ensure_data(instance_dir):
    """启动时调用：数据没了就自动从快照恢复（数据自愈）。

    判定「没数据」有两种情况：
      1. kanban.db 文件不存在（deploy 整目录清空）
      2. 库存在但照片/打卡都为 0（deploy 前被 init_db 建了空库）
    只要快照存在就恢复，绝不覆盖已有真实数据。
    """
    try:
        os.makedirs(os.path.join(instance_dir, 'data'), exist_ok=True)
        os.makedirs(os.path.join(instance_dir, 'uploads'), exist_ok=True)
    except Exception:
        pass
    if has_data(instance_dir):
        cnt = _user_data_count(instance_dir)
        if cnt != 0:
            return False, '数据存在，无需恢复'
        if not (SNAPSHOT and os.path.isfile(SNAPSHOT)):
            return False, '空库且无快照，按首次启动处理'
        LOG.warning('[persist] 检测到空库（照片/打卡均为 0），尝试从快照恢复')
    ok, msg = restore(instance_dir)
    if ok:
        LOG.warning('[persist] 检测到 instance/ 为空，已自动从快照恢复：%s', SNAPSHOT)
    else:
        LOG.info('[persist] 无有效快照或恢复失败（%s），按首次启动处理', msg)
    return ok, msg


_LAST_FP = {'v': None}


def start_auto_snapshot(instance_dir, interval=90):
    """后台线程：数据有变化就自动快照（默认 90 秒一轮）。"""
    def loop():
        while True:
            try:
                time.sleep(interval)
                fp = _fingerprint(instance_dir)
                if has_data(instance_dir) and fp != _LAST_FP['v']:
                    ok, msg = snapshot(instance_dir)
                    if ok:
                        _LAST_FP['v'] = fp
                        LOG.info('[persist] 自动快照完成：%s', msg)
            except Exception as e:
                LOG.warning('[persist] auto snapshot error: %s', e)
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t


def status():
    try:
        sz = os.path.getsize(SNAPSHOT) if SNAPSHOT and os.path.isfile(SNAPSHOT) else 0
        mt = (datetime.datetime.fromtimestamp(os.path.getmtime(SNAPSHOT)).isoformat(timespec='seconds')
              if sz else None)
    except Exception:
        sz, mt = 0, None
    return {
        'persist_dir': PERSIST_DIR,
        'snapshot': SNAPSHOT,
        'snapshot_size': sz,
        'snapshot_at': mt,
        'saved_at': LAST_STATE.get('saved_at'),
        'restored_at': LAST_STATE.get('restored_at'),
        'error': LAST_STATE.get('error'),
    }
