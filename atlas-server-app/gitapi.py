#!/usr/bin/env python3
"""Read-only git API + commit board for the Atlas server console's Git tab.

Stdlib only — this host has no node (node lives in containers). Binds to
loopback; caddy terminates basic_auth and serves it under /git, so this
process does no auth of its own. Every git call goes through run() with a
LIST argv (never a shell) and any caller-supplied sha is regex-validated,
so there is no injection surface.
"""
import json
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import os

REPO = os.environ.get('ATLAS_GIT_REPO', '/home/user/git/atlas.git')
BOARD = Path(__file__).with_name('git-board.html')
PORT = int(os.environ.get('ATLAS_GIT_PORT', '7682'))
DIFF_CAP = 400_000  # bytes of patch text per commit; huge diffs get truncated

US, RS = '\x1f', '\x1e'  # unit / record separators — safe inside commit messages
LOG_FMT = US.join(['%H', '%P', '%an', '%aI', '%D', '%s'])
SHA_RE = re.compile(r'[0-9a-f]{7,40}\Z')


def run(*args, cap=None):
    """git with list argv — no shell, so no quoting or injection concerns."""
    p = subprocess.run(['git', '--git-dir', REPO, *args],
                       capture_output=True, text=True, errors='replace', timeout=30)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or f'git {args[0]} failed')
    return p.stdout[:cap] if cap else p.stdout


def commit_list():
    """Every commit on every branch, newest first, with version numbers.

    Versions count from the oldest commit over this same --date-order listing,
    so v1 is the initial commit. Stable while history is only appended to —
    a rebase or amend would renumber (that's the ceiling).
    """
    out = run('log', '--all', '--date-order', f'--pretty=format:{LOG_FMT}{RS}')
    commits = []
    for rec in out.split(RS):
        rec = rec.strip('\n')
        if not rec:
            continue
        sha, parents, author, date, refs, subject = rec.split(US)
        commits.append({
            'sha': sha,
            'short': sha[:7],
            'parents': parents.split() if parents else [],
            'author': author,
            'date': date,
            # "HEAD -> main, tag: v1.0" → ["HEAD -> main", "tag: v1.0"]
            'refs': [r.strip() for r in refs.split(',') if r.strip()],
            'subject': subject,
        })
    total = len(commits)
    for i, c in enumerate(commits):  # listing is newest-first
        c['version'] = total - i
    return commits


def commit_detail(sha):
    meta = run('show', '-s', f'--format={LOG_FMT}{US}%b', sha)
    h, parents, author, date, refs, subject, body = meta.rstrip('\n').split(US)

    files = []
    # --numstat gives "added<TAB>removed<TAB>path"; "-" means a binary file
    for line in run('show', '--numstat', '--format=', sha).splitlines():
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        add, rem, path = parts[0], parts[1], parts[2]
        files.append({
            'path': path,
            'added': None if add == '-' else int(add),
            'removed': None if rem == '-' else int(rem),
        })

    patch = run('show', '--patch', '--format=', sha, cap=DIFF_CAP + 1)
    return {
        'sha': h, 'short': h[:7], 'parents': parents.split() if parents else [],
        'author': author, 'date': date, 'subject': subject, 'body': body.strip(),
        'refs': [r.strip() for r in refs.split(',') if r.strip()],
        'files': files, 'diff': patch[:DIFF_CAP], 'truncated': len(patch) > DIFF_CAP,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj), 'application/json')

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path in ('/', '/index.html', ''):
                return self._send(200, BOARD.read_bytes(), 'text/html; charset=utf-8')
            if u.path == '/api/log':
                return self._json({'commits': commit_list()})
            if u.path == '/api/commit':
                sha = (parse_qs(u.query).get('sha') or [''])[0]
                if not SHA_RE.match(sha):
                    return self._json({'error': 'bad sha'}, 400)
                return self._json(commit_detail(sha))
            if u.path == '/api/health':
                return self._json({'ok': True, 'repo': REPO})
            self._json({'error': 'not found'}, 404)
        except Exception as e:  # a broken repo should read as an error, not a hang
            self._json({'error': str(e)}, 500)

    def log_message(self, *a):
        pass  # the systemd unit's output already goes to journald


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
