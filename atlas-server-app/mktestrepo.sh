#!/bin/bash
# Throwaway repo with a deliberately awkward shape, to prove the board's lane
# assignment: a merged feature branch, a still-open branch, and a second merge.
set -e
R=/tmp/gittest
rm -rf $R $R.git
mkdir -p $R && cd $R
git init -q -b main
git config user.email t@t && git config user.name Tester
c() { echo "$2" > "$1"; git add -A; git commit -q -m "$3"; }

c a.txt 1 "v1 initial"
c a.txt 2 "v2 second on main"
git checkout -q -b feature
c f.txt 1 "v3 feature work"
c f.txt 2 "v4 more feature work"
git checkout -q main
c b.txt 1 "v5 main moves on"
git merge -q --no-ff feature -m "v6 merge feature into main"
git checkout -q -b experiment main~1
c e.txt 1 "v7 experiment, never merged"
c e.txt 2 "v8 experiment continues"
git checkout -q main
c c.txt 1 "v9 after the merge"
git checkout -q -b hotfix main
c h.txt 1 "v10 hotfix branch"
git checkout -q main
git merge -q --no-ff hotfix -m "v11 merge hotfix"

git clone -q --bare $R $R.git
echo "test repo built:"
git -C $R.git log --all --oneline --graph | head -20
