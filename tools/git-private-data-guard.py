#!/usr/bin/env python3
"""Reject private data in the staged tree or outgoing Git history.

Marker values are local-only. The hooks never print matching business content.
This complements (not replaces) keeping case data outside the repository.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MARKERS = Path(os.environ.get('ANQI_PRIVACY_MARKERS', str(Path.home() / 'Library/Application Support/cn.csslaw.anqi/git-private-markers.json')))
PRIVATE_PATH = re.compile(r'(^|/)(data|private-data|case-data|case-exports|feishu-exports|backups|secrets)(/|$)|\.(db|sqlite|sqlite3)(-wal|-shm)?$|(^|/)(sync-config|launcher-config|runtime)\.json$|\.(db|sqlite|sqlite3)-(wal|shm)$', re.I)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO)


def reasons(path, blob, markers):
    out = []
    if PRIVATE_PATH.search(path):
        out.append('private data path')
    if blob.startswith(b'SQLite format 3\0'):
        out.append('SQLite database')
    # Parse an actual export envelope; source code describing these keys must
    # not be mistaken for business data.
    if blob.lstrip().startswith((b'{', b'[')):
        try:
            value = json.loads(blob)
            pages = value if isinstance(value, list) else [value]
            for page in pages:
                if not isinstance(page, dict):
                    continue
                data = page.get('data', page)
                if isinstance(data, dict) and {'record_id_list', 'field_id_list'} <= data.keys():
                    out.append('raw Feishu export')
                    break
        except (ValueError, UnicodeDecodeError):
            pass
    if any(m and m in blob for m in markers):
        out.append('local private data marker')
    return out


def scan(mode, revisions):
    if not MARKERS.is_file():
        raise RuntimeError('Local private marker policy missing; restore it before commit/push')
    markers = [s.encode() for s in json.loads(MARKERS.read_text())['markers']]
    bad = []
    if mode == 'staged':
        entries = git('ls-files', '--stage', '-z').split(b'\0')
        pairs = [(e.split(b'\t', 1)[1].decode(), e.split(b' ', 2)[1].decode()) for e in entries if e]
    else:
        # Scan all local history not already known to this remote. For a new
        # remote, all reachable objects are reviewed, including old commits.
        remote = os.environ.get('ANQI_PUSH_REMOTE', '')
        args = ['rev-list', '--objects', *revisions]
        if remote and remote in git('remote').decode().split():
            args += ['--not', f'--remotes={remote}']
        pairs = []
        for line in git(*args).decode().splitlines():
            oid, _, name = line.partition(' ')
            if name and git('cat-file', '-t', oid).strip() == b'blob':
                pairs.append((name, oid))
    for path, oid in pairs:
        why = reasons(path, git('cat-file', 'blob', oid), markers)
        if why:
            # Keep paths and actual case names out of console / tracked work logs.
            bad.append({'object': oid[:12], 'reasons': why})
    if bad:
        print(json.dumps({'blocked': True, 'violations': bad}, ensure_ascii=False), file=sys.stderr)
        return 1
    print('Private-data guard passed')
    return 0


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('mode', choices=['staged', 'history'])
    a.add_argument('revisions', nargs='*', default=['HEAD'])
    args = a.parse_args()
    try:
        sys.exit(scan(args.mode, args.revisions or ['HEAD']))
    except Exception:
        print('Private-data guard could not complete; refusing operation', file=sys.stderr)
        sys.exit(1)
