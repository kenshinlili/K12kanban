#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bump_version.py —— 根据 commit message 前缀自动递增 kanban/VERSION。

版本号格式：V{major}.{minor}（两位，人类可读，如 V1.10、V2.12）

用法：
    python bump_version.py "fix: 修复 sync 主线程守门"
    python bump_version.py --type feat          # 显式指定类型
    python bump_version.py --dry-run            # 只看结果，不写文件

递增规则（conventional commits，统一 minor +1，仅架构变更才动 major）：
    feat / fix / perf        → minor +1    （V1.10 -> V1.11）
    breaking / BREAKING CHANGE → major +1，minor 归 0   （V1.11 -> V2.00）
    chore / docs / style / test / build / ci / refactor → 不递增（保持）
    （无法识别前缀时，默认按 fix 处理，即 minor +1，避免漏 bump）

说明：不区分 feat/fix 的递增幅度，二者都只让 minor 递增 1——这样版本号
始终是「每次代码改动 +1」的简单线性递增，一眼能看出哪个新、哪个旧。
只有破坏性/架构变更才升主版本并清零次版本。
"""
import os
import re
import sys

VERSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'VERSION')


def parse(v):
    m = re.match(r'^\s*V?(\d+)\.(\d+)\s*$', v or '')
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def fmt(major, minor):
    return 'V%d.%02d' % (major, minor)


def classify(msg):
    """根据 commit message 前缀返回类型：feat / fix / breaking / none"""
    m = (msg or '').strip()
    lower = m.lower()
    if lower.startswith('breaking') or 'breaking change' in lower or lower.startswith('refactor!'):
        return 'breaking'
    if lower.startswith('feat'):
        return 'feat'
    if lower.startswith('fix'):
        return 'fix'
    if lower.startswith(('chore', 'docs', 'style', 'test', 'build', 'ci', 'refactor')):
        return 'none'
    # 无法识别 → 默认按 fix（minor +1）
    return 'fix'


def bump(current, kind):
    parsed = parse(current)
    major, minor = parsed if parsed else (1, 0)
    if kind == 'breaking':
        return fmt(major + 1, 0)
    if kind in ('feat', 'fix'):
        return fmt(major, minor + 1)
    return fmt(major, minor)  # none


def main():
    args = sys.argv[1:]
    explicit_type = None
    msg = None
    dry_run = False

    i = 0
    while i < len(args):
        a = args[i]
        if a == '--dry-run':
            dry_run = True
        elif a == '--type':
            explicit_type = args[i + 1] if i + 1 < len(args) else None
            i += 1
        elif a.startswith('--type='):
            explicit_type = a.split('=', 1)[1]
        elif not a.startswith('--'):
            msg = a
        i += 1

    kind = explicit_type or classify(msg)

    with open(VERSION_FILE, encoding='utf-8') as f:
        current = f.read().strip()

    new = bump(current, kind)

    if not dry_run:
        with open(VERSION_FILE, 'w', encoding='utf-8') as f:
            f.write(new + '\n')

    print('%s -> %s  (type=%s)' % (current, new, kind))
    return new


if __name__ == '__main__':
    main()
