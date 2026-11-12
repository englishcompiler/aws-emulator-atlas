#!/usr/bin/env python3
"""Build the visualizer's data files from the AWS Emulator repos + release scores.

Inputs (read-only, never executed):
  src/aws-emulator/                    services/*/smithy-model, src/ops, issues/
  src/aws-emulator-evaluation-suite/   manifest.jsonl
  raw/scores-<tag>.json                scores.json.gz asset from GitHub releases

Outputs:
  site/data/summary.json               per-service rollup + global stats
  site/data/svc/<slug>.json            per-service ops, tests, issues
"""
import collections
import glob
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EMU = os.path.join(ROOT, "src/aws-emulator")
SUITE = os.path.join(ROOT, "src/aws-emulator-evaluation-suite")
OUT = os.path.join(ROOT, "site/data")
CUR, PREV = sys.argv[1], sys.argv[2]  # e.g. v1.0.322 v1.0.293


def snake(name):
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    return s.lower()


def walk_ops(shapes, sid, seen=None):
    seen = seen if seen is not None else set()
    sh = shapes.get(sid, {})
    out = []
    for key in ("operations", "collectionOperations"):
        for o in sh.get(key, []):
            out.append(o["target"])
    for key in ("create", "put", "read", "update", "delete", "list"):
        if key in sh:
            out.append(sh[key]["target"])
    for r in sh.get("resources", []):
        t = r["target"]
        if t not in seen:
            seen.add(t)
            out += walk_ops(shapes, t, seen)
    return out


# ---------------------------------------------------------------- services
services = {}  # shape id -> record
for crate in sorted(glob.glob(os.path.join(EMU, "services/service-*"))):
    models = glob.glob(os.path.join(crate, "smithy-model/*.json"))
    if not models:
        continue
    model = json.load(open(models[0]))
    shapes = model["shapes"]
    svc_ids = [k for k, v in shapes.items() if v["type"] == "service"]
    if not svc_ids:
        continue
    sid = svc_ids[0]
    tr = shapes[sid].get("traits", {})
    api = tr.get("aws.api#service", {})
    protos = [k.split("#")[1] for k in tr if k.startswith("aws.protocols#") or k == "smithy.protocols#rpcv2Cbor"]
    op_names = sorted({t.split("#")[1] for t in walk_ops(shapes, sid)})

    ops_dir = os.path.join(crate, "src/ops")
    files = {}
    for f in glob.glob(os.path.join(ops_dir, "*.rs")):
        stem = os.path.basename(f)[:-3]
        with open(f, errors="replace") as fh:
            head = fh.read(4000)
        files[stem] = "SCAFFOLDED, NOT IMPLEMENTED" in head
    skipped = set()
    sk = os.path.join(ops_dir, "SKIPPED_STUBS.md")
    if os.path.exists(sk):
        for line in open(sk):
            m = re.match(r"// SKIPPED: (\w+)", line)
            if m:
                skipped.add(m.group(1))

    ops = {}
    for op in op_names:
        st = snake(op)
        if op in skipped:
            status = "skipped"
        elif st in files:
            status = "stub" if files[st] else "impl"
        else:
            # Some generators keep acronyms together; fall back to a normalised match.
            norm = st.replace("_", "")
            cand = [k for k in files if k.replace("_", "") == norm]
            if cand:
                status = "stub" if files[cand[0]] else "impl"
            else:
                status = "missing"
        ops[op] = {"s": status, "t": 0, "p": 0}

    slug = os.path.basename(crate)[len("service-com-amazonaws-"):]
    services[sid] = {
        "slug": slug,
        "shape": sid,
        "title": tr.get("smithy.api#title", api.get("sdkId", sid)),
        "sdkId": api.get("sdkId", ""),
        "prefix": api.get("endpointPrefix", ""),
        "signing": tr.get("aws.auth#sigv4", {}).get("name", ""),
        "protocol": protos[0] if protos else "",
        "ops": ops,
        "tests": [],
        "issues": [],
    }
print("services", len(services), file=sys.stderr)

# ---------------------------------------------------------------- manifest
manifest = {}
for line in open(os.path.join(SUITE, "manifest.jsonl")):
    r = json.loads(line)
    manifest[r["check_id"]] = r

# ---------------------------------------------------------------- scores
def load_scores(tag):
    return json.load(open(os.path.join(ROOT, f"raw/scores-{tag}.json")))


cur = load_scores(CUR)
prev = load_scores(PREV)

# learn manifest prefix ("cognito-idp") -> shape id from single-service rows
prefix_votes = collections.defaultdict(collections.Counter)
for u in cur["units"]:
    if u["kind"] != "behavioral" or len(u["services"]) != 1:
        continue
    r = manifest.get(u["unitId"])
    if not r:
        continue
    for o in r["operations"]:
        prefix_votes[o.split(":")[0]][u["services"][0]] += 1
prefix_map = {p: c.most_common(1)[0][0] for p, c in prefix_votes.items()}
# fallback by endpoint prefix / signing name
for sid, s in services.items():
    for p in (s["prefix"], s["signing"], s["slug"].split("-")[0]):
        prefix_map.setdefault(p, sid)


def op_owner(full):
    p, op = full.split(":", 1)
    sid = prefix_map.get(p)
    if sid in services and op in services[sid]["ops"]:
        return sid, op
    # search services sharing that prefix
    for sid2, s in services.items():
        if op in s["ops"] and p in (s["prefix"], s["signing"]):
            return sid2, op
    return None, op


def labels_of(r):
    out = {}
    for l in r.get("labels", []):
        k, v = l.split(":", 1)
        out.setdefault(k, []).append(v)
    return out


prev_out = {u["unitId"]: u["outcome"] for u in prev["units"]}
mismatch_tot = collections.Counter()
status_pairs = collections.Counter()
for u in cur["units"]:
    det = u.get("detail") or {}
    if u["kind"] == "behavioral":
        r = manifest.get(u["unitId"], {})
        ops_full = r.get("operations", [])
        lab = labels_of(r) if r else {}
    else:
        steps = det.get("steps", [])
        ops_full = sorted({s["operation"] for s in steps if "operation" in s})
        ops_full = [f"@{o}" for o in ops_full]  # wire ops are service-local
        lab = {}
    t = {
        "id": u["unitId"],
        "k": "B" if u["kind"] == "behavioral" else "W",
        "o": u["outcome"][0],  # p / f / s
        "ax": (lab.get("axis") or [""])[0],
        "pl": "+".join(lab.get("plane", [])),
        "dp": "+".join(lab.get("dp", [])),
        "rt": 1 if "timing" in lab else 0,
        "n": len(u["services"]),
        "path": r.get("path", "") if u["kind"] == "behavioral" else "",
    }
    if det.get("mismatch"):
        t["mm"] = det["mismatch"]
        t["op"] = det.get("operation", "")
        t["ex"] = det.get("expected")
        t["ac"] = det.get("actual")
        mismatch_tot[det["mismatch"]] += 1
        if det["mismatch"] == "status":
            ex, ac = det.get("expected") or {}, det.get("actual") or {}
            status_pairs[f'{ex.get("status")}|{ex.get("errorCode","")}|{ac.get("status")}'] += 1
    if u.get("cause"):
        t["cause"] = u["cause"]
    po = prev_out.get(u["unitId"])
    t["prev"] = po[0] if po else ""
    t["svcs"] = [services[s]["slug"] for s in u["services"] if s in services]

    for sid in u["services"]:
        if sid in services:
            services[sid]["tests"].append(t)
    # attribute to operations
    touched = set()
    for full in ops_full:
        if full.startswith("@"):
            for sid in u["services"]:
                if sid in services and full[1:] in services[sid]["ops"]:
                    touched.add((sid, full[1:]))
        else:
            sid, op = op_owner(full)
            if sid and sid in u["services"]:  # only count tests scored for that service
                touched.add((sid, op))
    for sid, op in touched:
        rec = services[sid]["ops"][op]
        rec["t"] += 1
        if u["outcome"] == "pass":
            rec["p"] += 1
        if u["outcome"] == "fail" and det.get("operation") == op:
            rec["f1"] = rec.get("f1", 0) + 1  # failing step was this op

# ---------------------------------------------------------------- issues
issue_days = collections.defaultdict(lambda: [0, 0])
issue_sev = collections.Counter()
issue_cat = collections.Counter()
for state, d in (("open", "things-that-do-not-work"), ("fixed", "things-that-now-work")):
    for f in glob.glob(os.path.join(EMU, "issues", d, "*.md")):
        name = os.path.basename(f)
        hdr = {}
        title = ""
        with open(f, errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 60:
                    break
                m = re.match(r"(Issue-[\w-]+): (.*)", line)
                if m:
                    hdr.setdefault(m.group(1), m.group(2).strip())
                elif line.startswith("# ") and not title:
                    title = line[2:].strip()
                    break
        issue_sev[state + "|" + hdr.get("Issue-Severity", "?")] += 1
        cat = "stub" if name.endswith("-stub.md") else "wrong-behavior" if "wrong-behavior" in name else "other"
        issue_cat[state + "|" + cat] += 1
        day = name[:8]
        if re.match(r"\d{8}", day):
            issue_days[day][0 if state == "open" else 1] += 1
        iss = {
            "f": name,
            "st": state[0],
            "sev": hdr.get("Issue-Severity", "")[:1],
            "ck": hdr.get("Issue-Corpus-Kind", ""),
            "t": title[:220],
        }
        sid = hdr.get("Issue-Shape-Id", "")
        if sid in services:
            services[sid]["issues"].append(iss)

# ---------------------------------------------------------------- rollup
def score(tests):
    c = collections.Counter(t["o"] for t in tests)
    return c["p"], c["p"] + c["f"]


summary = []
glob_ops = collections.Counter()
for sid, s in services.items():
    ops = s["ops"]
    st = collections.Counter(o["s"] for o in ops.values())
    glob_ops.update(st)
    tested = sum(1 for o in ops.values() if o["t"])
    impl_untested = sum(1 for o in ops.values() if o["t"] == 0 and o["s"] == "impl")
    T = s["tests"]
    k, n = score(T)
    ks, ns = score([t for t in T if t["n"] == 1])
    kw, nw = score([t for t in T if t["k"] == "W"])
    kb, nb = score([t for t in T if t["k"] == "B"])
    kh, nh = score([t for t in T if t["ax"] == "happy-path"])
    kr, nr = score([t for t in T if t["ax"] == "rejection"])
    kc, nc = score([t for t in T if "control" in t["pl"]])
    kd, nd = score([t for t in T if "data" in t["pl"]])
    pk, pn = score([{"o": t["prev"]} for t in T if t["prev"]])
    newly = sum(1 for t in T if t["prev"] == "f" and t["o"] == "p")
    mm = collections.Counter(t.get("mm") for t in T if t.get("mm"))
    sev = collections.Counter(i["sev"] for i in s["issues"] if i["st"] == "o")
    summary.append({
        "slug": s["slug"], "title": s["title"], "sdkId": s["sdkId"], "prefix": s["prefix"],
        "protocol": s["protocol"],
        "ops": len(ops), "impl": st["impl"], "stub": st["stub"], "skipped": st["skipped"] + st["missing"],
        "tested": tested, "implUntested": impl_untested,
        "k": k, "n": n, "ks": ks, "ns": ns, "kw": kw, "nw": nw, "kb": kb, "nb": nb,
        "kh": kh, "nh": nh, "kr": kr, "nr": nr, "kc": kc, "nc": nc, "kd": kd, "nd": nd,
        "pk": pk, "pn": pn, "newly": newly,
        "mm": dict(mm),
        "topFail": max(([o, v.get("f1", 0)] for o, v in ops.items()), key=lambda x: x[1], default=["", 0]),
        "io": sum(1 for i in s["issues"] if i["st"] == "o"),
        "if": sum(1 for i in s["issues"] if i["st"] == "f"),
        "sev": dict(sev),
    })
    os.makedirs(os.path.join(OUT, "svc"), exist_ok=True)
    with open(os.path.join(OUT, "svc", s["slug"] + ".json"), "w") as fh:
        json.dump({
            "slug": s["slug"], "shape": sid, "title": s["title"], "sdkId": s["sdkId"],
            "protocol": s["protocol"], "prefix": s["prefix"],
            "ops": [{"name": k2, **v} for k2, v in sorted(ops.items())],
            "tests": T,
            "issues": sorted(s["issues"], key=lambda i: i["f"], reverse=True),
        }, fh, separators=(",", ":"))

all_units = cur["units"]
oc = collections.Counter(u["outcome"] for u in all_units)
poc = collections.Counter(u["outcome"] for u in prev["units"])
kinds = {k: collections.Counter(u["outcome"] for u in all_units if u["kind"] == k) for k in ("wire", "behavioral")}
lab_tot = collections.defaultdict(collections.Counter)
for u in all_units:
    r = manifest.get(u["unitId"])
    if not r:
        continue
    for l in r["labels"]:
        lab_tot[l][u["outcome"]] += 1
multi = collections.Counter((min(len(u["services"]), 5), u["outcome"]) for u in all_units)
skipped_causes = collections.Counter(u.get("cause") for u in all_units if u["outcome"] == "skipped")

meta = {
    "release": CUR, "prev": PREV,
    "builtAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="minutes"),
    "scoredAt": cur["scoredAt"], "commit": cur["commit"],
    "prevScoredAt": prev["scoredAt"],
    "units": len(all_units), "outcomes": dict(oc), "prevOutcomes": dict(poc),
    "kinds": {k: dict(v) for k, v in kinds.items()},
    "labels": {k: dict(v) for k, v in lab_tot.items()},
    "multi": {f"{a}|{b}": c for (a, b), c in multi.items()},
    "mismatch": dict(mismatch_tot),
    "statusPairs": status_pairs.most_common(14),
    "skippedCauses": dict(skipped_causes),
    "ops": dict(glob_ops),
    "services": len(services),
    "manifestRows": len(manifest),
    "issueSev": dict(issue_sev), "issueCat": dict(issue_cat),
    "issueDays": {k: v for k, v in sorted(issue_days.items())},
}
with open(os.path.join(OUT, "summary.json"), "w") as fh:
    json.dump({"meta": meta, "services": summary}, fh, separators=(",", ":"))
print(json.dumps({k: meta[k] for k in ("units", "outcomes", "ops", "services", "mismatch")}), file=sys.stderr)

# ---------------------------------------------------------------- ops index for the project checker
aliases = collections.defaultdict(set)
for p, sid in prefix_map.items():
    if sid in services:
        aliases[services[sid]["slug"]].add(p)
idx = {"aliases": {}, "svc": {}}
for sid, s in services.items():
    sl = s["slug"]
    names = set(aliases[sl]) | {s["prefix"], s["signing"], s["sdkId"].lower().replace(" ", "-"), s["sdkId"].lower().replace(" ", "")}
    for a in names:
        if a:
            idx["aliases"].setdefault(a, [])
            if sl not in idx["aliases"][a]:
                idx["aliases"][a].append(sl)
    idx["svc"][sl] = {"title": s["title"], "ops": {k: [v["s"][0], v["t"], v["p"]] for k, v in s["ops"].items()}}
with open(os.path.join(OUT, "ops-index.json"), "w") as fh:
    json.dump(idx, fh, separators=(",", ":"))
