# -*- coding: utf-8 -*-
"""发布前给 kanban/version.json 打构建戳（commit + 提交时间）。

用法：
    python write_version.py          # 用本地 git HEAD 打戳
    python write_version.py --dry    # 只看结果不写文件

为什么需要它
------------
version.json 被 .gitignore 忽略（云端运行时生成），但它**会随 deploy 一起上传**。
如果本地留着一份很早以前的 version.json，deploy 后云端就会显示过期的 commit，
导致「版本号对不上」「sync 守门判断失真」。

所以规则：每次 deploy 前跑一次本脚本，让 version.json 与当前代码真实对应。
"""
import os
import sys
import json
import subprocess
import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE_DIR)
VERSION_FILE = os.path.join(BASE_DIR, 'VERSION')
OUT_FILE = os.path.join(BASE_DIR, 'version.json')


def git(*args):
    try:
        out = subprocess.run(['git', '-C', REPO_ROOT, *args],
                             capture_output=True, text=True, timeout=15)
        if out.returncode != 0:
            return ''
        return out.stdout.strip()
    except Exception:
        return ''


def read_semantic():
    try:
        with open(VERSION_FILE, encoding='utf-8') as f:
            v = f.read().strip()
            return v or 'V0.00'
    except Exception:
        return 'V0.00'


def main():
    dry = '--dry' in sys.argv
    commit = git('rev-parse', 'HEAD')
    branch = git('rev-parse', '--abbrev-ref', 'HEAD') or 'master'
    date = git('log', '-1', '--format=%cI')
    dirty = bool(git('status', '--porcelain'))

    data = {
        'commit': commit or 'unknown',
        'short': (commit[:12] if commit else 'unknown'),
        'branch': branch,
        'commit_date': date or None,
        'built_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'dirty': dirty,
    }
    print(json.dumps(data, ensure_ascii=False, indent=2))
    if dirty:
        print('\n[warn] 工作区有未提交改动，打出的 commit 戳不包含这些改动')
    if dry:
        print('\n[dry-run] 未写入文件')
        return
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'\n[ok] 已写入 {OUT_FILE}')


if __name__ == '__main__':
    main()
