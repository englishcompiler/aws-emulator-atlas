#!/usr/bin/env python3
"""Fetch the newest scored AWS Emulator release and rebuild site/data.

Used by .github/workflows/update.yml, and works locally too (needs `gh` and `git`).

  python3 scripts/update.py            # rebuild only if a newer scored release exists
  python3 scripts/update.py --force    # rebuild even if the deployed site is current

Writes `changed=true|false` and `release=<tag>` to $GITHUB_OUTPUT when set.
"""
import gzip
import json
import os
import shutil
import subprocess
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO = "aws/aws-emulator"
SUITE = "aws/aws-emulator-evaluation-suite"
SITE_URL = os.environ.get("SITE_URL", "https://englishcompiler.github.io/aws-emulator-atlas/")
FORCE = "--force" in sys.argv


def sh(*cmd, **kw):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, text=True, **kw)


def out(key, val):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as fh:
            fh.write(f"{key}={val}\n")
    print(f"{key}={val}")


def scored_releases():
    """Newest-first tags of releases that ship scores.json.gz."""
    res = sh("gh", "api", f"repos/{REPO}/releases?per_page=60", capture_output=True)
    rels = json.loads(res.stdout)
    rels = [r for r in rels if not r.get("draft") and any(a["name"] == "scores.json.gz" for a in r["assets"])]
    rels.sort(key=lambda r: r["published_at"], reverse=True)
    return [r["tag_name"] for r in rels]


def deployed_release():
    try:
        with urllib.request.urlopen(SITE_URL.rstrip("/") + "/data/summary.json", timeout=30) as r:
            return json.load(r)["meta"]["release"]
    except Exception as e:  # first deploy, or site down
        print("could not read deployed release:", e)
        return None


def main():
    tags = scored_releases()
    if not tags:
        sys.exit("no release with scores.json.gz found")
    cur = tags[0]
    prev = tags[1] if len(tags) > 1 else tags[0]
    live = deployed_release()
    print(f"latest scored release {cur} (previous {prev}); deployed {live}")
    out("release", cur)
    if live == cur and not FORCE:
        out("changed", "false")
        return

    raw = os.path.join(ROOT, "raw")
    os.makedirs(raw, exist_ok=True)
    for tag in {cur, prev}:
        gz = os.path.join(raw, f"scores-{tag}.json.gz")
        sh("gh", "release", "download", tag, "-R", REPO, "-p", "scores.json.gz", "-O", gz, "--clobber")
        with gzip.open(gz, "rb") as src, open(gz[:-3], "wb") as dst:
            shutil.copyfileobj(src, dst)

    src = os.path.join(ROOT, "src")
    os.makedirs(src, exist_ok=True)
    emu, suite = os.path.join(src, "aws-emulator"), os.path.join(src, "aws-emulator-evaluation-suite")
    for d in (emu, suite):
        shutil.rmtree(d, ignore_errors=True)
    # The source tree and issues/ are pinned to the scored release tag so stubs and issues
    # describe the same commit the scores came from. The evaluation suite has no tags; use HEAD.
    sh("git", "clone", "-q", "--depth", "1", "--branch", cur, f"https://github.com/{REPO}.git", emu)
    sh("git", "clone", "-q", "--depth", "1", f"https://github.com/{SUITE}.git", suite)

    data = os.path.join(ROOT, "site", "data")
    shutil.rmtree(data, ignore_errors=True)  # drop per-service files of services that disappeared
    sh(sys.executable, "-I", os.path.join(ROOT, "scripts", "build_data.py"), cur, prev)
    out("changed", "true")


if __name__ == "__main__":
    main()
