/* Emulator Fidelity Atlas — vanilla JS, no build step. */
(() => {
  "use strict";
  const GH_EMU = "https://github.com/aws/aws-emulator/blob/main/";
  const GH_SUITE = "https://github.com/aws/aws-emulator-evaluation-suite/blob/main/";
  const app = document.getElementById("app");
  const tip = document.getElementById("tip");

  // ------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n ?? 0).toLocaleString("en-US");
  const pct = (k, n) => (n ? (100 * k) / n : null);
  const pctS = (k, n, d = 0) => (n ? ((100 * k) / n).toFixed(d) + "%" : "—");
  const short = (s) => s.sdkId || s.title;
  const snake = (op) => op.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const tipAttr = (title, rows, extra = "") =>
    `data-tip="${esc(`<div class="tt">${esc(title)}</div>` + rows.map(([a, b]) => `<div class="tr"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join("") + (extra ? `<div class="small" style="margin-top:4px">${esc(extra)}</div>` : ""))}"`;
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    if (t) return t === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const seqIdx = (p) => Math.max(0, Math.min(8, Math.floor((p / 100) * 9 - 1e-9)));
  const seqBg = (p) => `var(--seq-${seqIdx(p)})`;
  const seqInk = (p) => {
    const i = seqIdx(p);
    return isDark() ? (i >= 6 ? "#0b0b0b" : "#f0efec") : i >= 5 ? "#ffffff" : "#0b0b0b";
  };
  const passChip = (o) => (o === "p" ? `<span class="chip good">pass</span>` : o === "f" ? `<span class="chip crit">fail</span>` : `<span class="chip neutral">skipped</span>`);
  const opChip = (s, t) =>
    s === "impl"
      ? t ? `<span class="chip tested">implemented</span>` : `<span class="chip untested">implemented · no test</span>`
      : s === "stub" ? `<span class="chip stub">stub · 501</span>` : `<span class="chip none">not routable</span>`;
  const sevChip = (s) => ({ C: `<span class="chip crit">critical</span>`, H: `<span class="chip ser">high</span>`, M: `<span class="chip warn">medium</span>`, L: `<span class="chip neutral">low</span>` }[s] || "");

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " → " + r.status);
    return r.json();
  }
  let SUM = null, IDX = null;
  const SVC = new Map();
  const bySlug = new Map();
  const svcData = async (slug) => {
    if (!SVC.has(slug)) SVC.set(slug, await getJSON(`data/svc/${slug}.json`));
    return SVC.get(slug);
  };

  // ------------------------------------------------------------ tooltip
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    tip.innerHTML = el.getAttribute("data-tip");
    tip.hidden = false;
  });
  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && !el.contains(e.relatedTarget)) tip.hidden = true;
  });
  document.addEventListener("mousemove", (e) => {
    if (tip.hidden) return;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  });
  addEventListener("scroll", () => (tip.hidden = true), { passive: true });

  // ------------------------------------------------------------ theme
  const themeBtn = document.getElementById("theme");
  try { const t = localStorage.getItem("atlas-theme"); if (t) document.documentElement.dataset.theme = t; } catch (_) {}
  themeBtn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("atlas-theme", next); } catch (_) {}
    route();
  });

  // ------------------------------------------------------------ chart pieces
  function segBar(parts, cls = "") {
    const tot = parts.reduce((a, p) => a + p.v, 0) || 1;
    return `<div class="seg ${cls}">${parts
      .filter((p) => p.v > 0)
      .map((p) => `<div style="flex:${p.v} 1 0;background:var(${p.c})" ${tipAttr(p.l, [["Operations", fmt(p.v)], ["Share", pctS(p.v, tot, 1)]], p.d || "")}></div>`)
      .join("")}</div>`;
  }
  function legend(parts) {
    const tot = parts.reduce((a, p) => a + p.v, 0) || 1;
    return `<div class="legend">${parts.map((p) => `<span><i style="background:var(${p.c})"></i>${esc(p.l)}<b class="num">${fmt(p.v)}</b> <span class="muted">${pctS(p.v, tot)}</span></span>`).join("")}</div>`;
  }
  function opParts(s) {
    return [
      { l: "Implemented & tested", v: s.impl - s.implUntested, c: "--op-tested", d: "A real handler exists and at least one fidelity test calls it." },
      { l: "Implemented, no test", v: s.implUntested, c: "--op-untested", d: "A handler exists but no fidelity test calls it: behaviour unverified." },
      { l: "Stub (HTTP 501)", v: s.stub, c: "--op-stub", d: "Scaffolded but not implemented: answers 501 NotImplemented." },
      { l: "Not routable", v: s.skipped, c: "--op-none", d: "Modeled, but no handler was generated (streaming / unit input etc.)." },
    ];
  }
  function passRow(label, k, n, href, extraTip) {
    const p = pct(k, n);
    const lab = href ? `<a class="lab" href="${href}">${esc(label)}</a>` : `<span class="lab">${esc(label)}</span>`;
    return `<div class="brow" ${tipAttr(label, [["Passing", fmt(k)], ["Failing", fmt(n - k)], ["Pass rate", pctS(k, n, 1)]], extraTip || "")}>
      ${lab}<div class="track"><span style="width:${p ?? 0}%"></span><i class="mark50"></i></div>
      <span class="val num"><b>${p == null ? "—" : p.toFixed(0) + "%"}</b> · ${fmt(k)}/${fmt(n)}</span></div>`;
  }
  function countRow(label, v, max, href, sub) {
    const lab = href ? `<a class="lab" href="${href}">${esc(label)}</a>` : `<span class="lab">${esc(label)}</span>`;
    return `<div class="brow" ${tipAttr(label, [["Count", fmt(v)]], sub || "")}>${lab}<div class="track"><span style="width:${(100 * v) / (max || 1)}%;border-radius:0 4px 4px 0"></span></div><span class="val num"><b>${fmt(v)}</b></span></div>`;
  }

  // ------------------------------------------------------------ router
  function route() {
    tip.hidden = true;
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    const params = new URLSearchParams(qs || "");
    const parts = path.split("/").filter(Boolean);
    const name = parts[0] || "overview";
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.route === (name === "svc" ? "services" : name)));
    const views = { overview, services, svc: () => serviceView(parts[1], params), check: () => checkView(params), issues: issuesView, about };
    (views[name] || overview)(params);
  }
  addEventListener("hashchange", () => { route(); scrollTo(0, 0); });

  // ------------------------------------------------------------ overview
  const CORE = ["S3", "Lambda", "DynamoDB", "SQS", "SNS", "IAM", "STS", "KMS", "Secrets Manager", "SSM", "CloudFormation", "API Gateway", "ApiGatewayV2", "EventBridge", "SFN", "CloudWatch Logs", "CloudWatch", "ECS", "ECR", "EKS", "EC2", "Cognito Identity Provider", "RDS", "Elastic Load Balancing v2", "Kinesis", "Route 53", "CloudFront", "OpenSearch", "Athena", "Glue", "SESv2", "Bedrock Runtime"];
  let coreMode = "all", atlasMetric = "fid", atlasSort = "tests", atlasQ = "";

  function overview() {
    const M = SUM.meta, S = SUM.services;
    const k = M.outcomes.pass, n = M.units;
    const pk = M.prevOutcomes.pass, pn = Object.values(M.prevOutcomes).reduce((a, b) => a + b, 0);
    const ops = S.reduce((a, s) => a + s.ops, 0), impl = S.reduce((a, s) => a + s.impl, 0), stub = S.reduce((a, s) => a + s.stub, 0);
    const tested = S.reduce((a, s) => a + s.tested, 0), untestedImpl = S.reduce((a, s) => a + s.implUntested, 0);
    const noTests = S.filter((s) => !s.n).length;
    const openI = (M.issueCat["open|stub"] || 0) + (M.issueCat["open|wrong-behavior"] || 0) + (M.issueCat["open|other"] || 0);
    const fixedI = (M.issueCat["fixed|stub"] || 0) + (M.issueCat["fixed|wrong-behavior"] || 0) + (M.issueCat["fixed|other"] || 0);
    const newly = S.reduce((a, s) => a + s.newly, 0);
    const L = M.labels;
    const lp = (key) => [L[key]?.pass || 0, (L[key]?.pass || 0) + (L[key]?.fail || 0)];
    const [cK, cN] = lp("plane:control"), [eK, eN] = lp("dp:endpoint"), [nK, nN] = lp("dp:native");
    const all = { impl, stub, skipped: S.reduce((a, s) => a + s.skipped, 0), implUntested: untestedImpl };
    const cfn = S.find((s) => s.sdkId === "CloudFormation");

    app.innerHTML = `
    <div class="eyebrow">Release ${esc(M.release)} · scored ${new Date(M.scoredAt).toUTCString().slice(5, 16)} · commit <a class="mono" href="https://github.com/aws/aws-emulator/commit/${M.commit}">${M.commit.slice(0, 7)}</a></div>
    <div class="hero">
      <div>
        <h1>How much of AWS does AWS&nbsp;Emulator really cover?</h1>
        <p class="lede">AWS shipped a local emulator generated from ${fmt(M.services)} published API models. This atlas joins its own release scores, its test manifest, its source tree and its issue tracker, so you can see per service and per operation what works, what is only a stub, and what nothing tests yet.</p>
      </div>
      <div class="card" style="margin:0">
        <div class="hero-fig num">${pctS(k, n, 1)}</div>
        <div class="small" style="margin-top:8px">of <b>${fmt(n)}</b> fidelity tests pass (${fmt(k)} pass, ${fmt(M.outcomes.fail)} fail, ${fmt(M.outcomes.skipped || 0)} skipped)</div>
        <div class="small muted" style="margin-top:2px">Previous scored release ${esc(M.prev)}: ${pctS(pk, pn, 1)} of ${fmt(pn)} · ${fmt(newly)} tests flipped fail → pass since</div>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="v num">${fmt(impl)}<small>/ ${fmt(ops)}</small></div><div class="l">operations have a real handler</div><div class="d">${pctS(impl, ops, 1)} of every modeled operation</div></div>
      <div class="kpi"><div class="v num">${fmt(stub)}</div><div class="l">operations are stubs that answer 501</div><div class="d">calls fail immediately</div></div>
      <div class="kpi"><div class="v num">${fmt(tested)}</div><div class="l">operations are called by ≥1 fidelity test</div><div class="d">${fmt(untestedImpl)} implemented ops have no test</div></div>
      <div class="kpi"><div class="v num">${fmt(noTests)}</div><div class="l">of ${fmt(M.services)} service models have no test at all</div><div class="d">${fmt(M.services - noTests)} are scored</div></div>
      <div class="kpi"><div class="v num">${fmt(openI)}</div><div class="l">open tracked gaps</div><div class="d">${fmt(fixedI)} already moved to “now works”</div></div>
    </div>

    <div class="callouts">
      <div class="callout"><b class="num">${pctS(cK, cN)} vs ${pctS(eK, eN)}</b><span>Control-plane tests pass far more often than data-plane tests that hit a non-API endpoint (API Gateway stage, CloudFront, load balancer URL).</span></div>
      <div class="callout"><b class="num">${fmt(nK)} of ${fmt(nN)}</b><span>tests that speak a native protocol (database, cache, broker, shell) pass. There is no real engine behind RDS, ElastiCache or MSK.</span></div>
      <div class="callout"><b class="num">${fmt(cfn?.topFail?.[1] || 0)}</b><span>of CloudFormation's ${fmt((cfn?.n || 0) - (cfn?.k || 0))} failing tests stop at the same call, <code>${esc(cfn?.topFail?.[0] || "")}</code> (a resource-type registry lookup). That one gap explains most of its ${pctS(cfn?.k, cfn?.n)} score.</span></div>
    </div>

    <div class="card">
      <div class="row"><div><h2>Where every modeled operation stands</h2><p class="sub">${fmt(ops)} operations across ${fmt(M.services)} Smithy models. “Implemented” only means a handler exists; whether it matches AWS is what the tests measure.</p></div></div>
      ${segBar(opParts(all))}${legend(opParts(all))}
    </div>

    <div class="grid2">
      <div class="card">
        <div class="row" style="align-items:flex-start"><div><h2>Services you probably use</h2><p class="sub">Pass rate of the fidelity tests that touch each service.</p></div><span class="spacer"></span>
        <div class="seg-ctl" id="coreMode"><button data-v="all" class="${coreMode === "all" ? "on" : ""}">All tests</button><button data-v="single" class="${coreMode === "single" ? "on" : ""}">Single-service</button></div></div>
        <div class="bars" id="coreBars"></div>
        <p class="small muted" style="margin:12px 0 0">“All tests” includes cross-service workflows (e.g. a Lambda reading SQS through CloudFormation), which also counts against every service in the chain. The line marks 50%.</p>
      </div>
      <div class="card">
        <h2>Fidelity by kind of test</h2><p class="sub">Each test carries labels from the suite's taxonomy. Where the emulator is weakest is clear.</p>
        <div class="bars">${dimRows()}</div>
      </div>
    </div>

    <div class="card" style="margin-top:20px">
      <div class="row" style="align-items:flex-start"><div><h2>Service atlas</h2><p class="sub">Every service model, one tile each. Click a tile for its operations, tests and issues.</p></div></div>
      <div class="controls">
        <div class="seg-ctl" id="atlasMetric">
          <button data-v="fid">Test pass rate</button><button data-v="impl">Ops implemented</button><button data-v="cov">Ops with a test</button>
        </div>
        <div class="seg-ctl" id="atlasSort"><button data-v="tests">Most tested</button><button data-v="score">Score</button><button data-v="name">A–Z</button></div>
        <input type="search" id="atlasQ" placeholder="Filter services…" value="${esc(atlasQ)}" style="width:200px">
        <span class="spacer"></span>
        <div class="scale"><span>0%</span><span class="ramp"></span><span>100%</span><span class="na"></span><span>no tests</span></div>
      </div>
      <div class="tiles" id="tiles"></div>
    </div>

    <div class="grid2">
      <div class="card">
        <h2>Implemented ≠ faithful</h2><p class="sub">Each dot is a scored service: share of its operations with a handler vs. share of its tests that pass. Dot area is test count.</p>
        <div id="scatter"></div>
      </div>
      <div class="card">
        <h2>When a request-level test fails, what differs?</h2><p class="sub">${fmt(Object.values(M.mismatch).reduce((a, b) => a + b, 0))} wire tests replay recorded AWS request/response pairs and stop at the first mismatch.</p>
        <div class="bars">${mismatchRows()}</div>
        <h3 style="margin-top:18px">Most common status mismatches</h3>
        <div class="tbl-wrap"><table><thead><tr><th>AWS answered</th><th>Emulator answered</th><th class="r">Tests</th></tr></thead><tbody>
        ${M.statusPairs.slice(0, 8).map(([key, c]) => { const [es, ec, as] = key.split("|"); return `<tr><td>${es} ${ec && !ec.startsWith("<") ? `<span class="muted">${esc(ec)}</span>` : ""}</td><td>${as} ${as === "501" ? `<span class="muted">NotImplemented</span>` : ""}</td><td class="r">${fmt(c)}</td></tr>`; }).join("")}
        </tbody></table></div>
        <p class="small muted" style="margin:10px 0 0">“200 → 404” is almost entirely CloudFormation <code>DescribeType</code>: the emulator does not know the resource type being described. “→ 501” rows are calls into stub operations.</p>
      </div>
    </div>`;

    const drawCore = () => {
      const rows = CORE.map((id) => S.find((s) => s.sdkId === id)).filter(Boolean)
        .map((s) => ({ s, k: coreMode === "all" ? s.k : s.ks, n: coreMode === "all" ? s.n : s.ns }))
        .sort((a, b) => pct(b.k, b.n) - pct(a.k, a.n));
      document.getElementById("coreBars").innerHTML = rows.map(({ s, k, n }) => passRow(short(s), k, n, `#/svc/${s.slug}`, `${s.impl}/${s.ops} ops implemented · ${s.stub} stubs · ${s.io} open issues`)).join("");
    };
    drawCore();
    bindSeg("coreMode", (v) => { coreMode = v; drawCore(); });
    bindSeg("atlasMetric", (v) => { atlasMetric = v; drawTiles(); }, atlasMetric);
    bindSeg("atlasSort", (v) => { atlasSort = v; drawTiles(); }, atlasSort);
    document.getElementById("atlasQ").addEventListener("input", (e) => { atlasQ = e.target.value; drawTiles(); });
    drawTiles();
    drawScatter();
  }

  function bindSeg(id, fn, initial) {
    const el = document.getElementById(id);
    if (initial) el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === initial));
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      fn(b.dataset.v);
    });
  }

  function dimRows() {
    const M = SUM.meta, L = M.labels;
    const r = (label, key, tipx) => { const o = L[key] || {}; return passRow(label, o.pass || 0, (o.pass || 0) + (o.fail || 0), null, tipx); };
    const kind = (k) => M.kinds[k];
    const multi = (i) => { const p = M.multi[`${i}|pass`] || 0, f = M.multi[`${i}|fail`] || 0; return [p, p + f]; };
    let h = `<div class="bgroup">How the test checks</div>`;
    h += passRow("Wire (request replay)", kind("wire").pass, kind("wire").pass + kind("wire").fail, null, "Replays recorded AWS HTTP exchanges and compares status, headers and body.");
    h += passRow("Behavioral (SDK program)", kind("behavioral").pass, kind("behavioral").pass + kind("behavioral").fail, null, "A boto3 program asserting results, resulting state and exact errors.");
    h += `<div class="bgroup">Plane</div>` + r("Control plane", "plane:control", "Create / describe / update / delete resources.") + r("Data plane", "plane:data", "Writing, reading, sending, invoking.");
    h += `<div class="bgroup">Data-plane path</div>` + r("Signed AWS API", "dp:api", "e.g. S3 PutObject, SQS SendMessage.") + r("Non-API endpoint", "dp:endpoint", "HTTP to an API Gateway stage, CloudFront, a load balancer…") + r("Native protocol", "dp:native", "Postgres/MySQL wire, Redis, Kafka, shell on an instance.");
    h += `<div class="bgroup">Outcome asserted</div>` + r("Happy path", "axis:happy-path") + r("Rejection (exact error)", "axis:rejection", "AWS refuses the call; the emulator must refuse with the same code and unchanged state.") + r("Negative delivery", "axis:negative-delivery", "Something must NOT arrive (filtered event, non-matching record).") + r("Waits real time", "timing:real-time", "TTLs, schedules, alarm periods, delivery buffers.");
    h += `<div class="bgroup">Services in one test</div>`;
    for (const i of [1, 2, 3, 4, 5]) { const [p, n] = multi(i); h += passRow(i === 5 ? "5 or more" : `${i} service${i > 1 ? "s" : ""}`, p, n); }
    return h;
  }

  function mismatchRows() {
    const M = SUM.meta.mismatch;
    const rows = Object.entries(M).sort((a, b) => b[1] - a[1]);
    const max = rows[0][1];
    const desc = { status: "Different HTTP status (incl. 501 stubs and 404 unknown resources).", body: "Same status, but response body fields differ.", headers: "Response headers differ.", transport: "Connection-level failure.", binding: "Request could not be bound to the operation." };
    return rows.map(([k, v]) => countRow(k[0].toUpperCase() + k.slice(1), v, max, null, desc[k])).join("");
  }

  function metricOf(s) {
    if (atlasMetric === "impl") return pct(s.impl, s.ops);
    if (atlasMetric === "cov") return pct(s.tested, s.ops);
    return s.n ? pct(s.k, s.n) : null;
  }
  function drawTiles() {
    const q = norm(atlasQ);
    let S = [...SUM.services];
    if (atlasSort === "tests") S.sort((a, b) => b.n - a.n || b.ops - a.ops);
    else if (atlasSort === "score") S.sort((a, b) => (metricOf(b) ?? -1) - (metricOf(a) ?? -1) || b.n - a.n);
    else S.sort((a, b) => short(a).localeCompare(short(b)));
    document.getElementById("tiles").innerHTML = S.map((s) => {
      const m = metricOf(s);
      const hit = !q || norm(s.sdkId + s.title + s.slug + s.prefix).includes(q);
      const tipRows = [["Test pass rate", s.n ? `${pctS(s.k, s.n, 1)} (${fmt(s.k)}/${fmt(s.n)})` : "no tests"], ["Ops implemented", `${fmt(s.impl)}/${fmt(s.ops)}`], ["501 stubs", fmt(s.stub)], ["Ops with a test", `${fmt(s.tested)}/${fmt(s.ops)}`], ["Open issues", fmt(s.io)]];
      const style = m == null ? "" : `style="background:${seqBg(m)};color:${seqInk(m)}"`;
      return `<a class="tile ${m == null ? "na" : ""} ${hit ? "" : "dim"}" href="#/svc/${s.slug}" ${style} ${tipAttr(s.title, tipRows)}><span class="tn">${esc(short(s))}</span><span class="tv">${m == null ? "—" : m.toFixed(0) + "%"}</span></a>`;
    }).join("");
  }

  function drawScatter() {
    const el = document.getElementById("scatter");
    const W = Math.max(320, el.clientWidth || 520), H = 330, ml = 54, mr = 12, mt = 10, mb = 36;
    const S = SUM.services.filter((s) => s.n >= 5);
    const x = (v) => ml + (v / 100) * (W - ml - mr), y = (v) => mt + (1 - v / 100) * (H - mt - mb);
    const maxN = Math.max(...S.map((s) => s.n));
    const r = (n) => 3.5 + 13 * Math.sqrt(n / maxN);
    let g = "";
    for (const t of [0, 25, 50, 75, 100]) {
      g += `<line class="gl" x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}"/><text x="${ml - 6}" y="${y(t) + 4}" text-anchor="end">${t}%</text>`;
      g += `<text x="${x(t)}" y="${H - mb + 16}" text-anchor="middle">${t}%</text>`;
    }
    g += `<line class="ax" x1="${ml}" x2="${W - mr}" y1="${y(0)}" y2="${y(0)}"/>`;
    g += `<text x="${(ml + W - mr) / 2}" y="${H - 4}" text-anchor="middle" class="lbl">Operations with a handler →</text>`;
    g += `<text transform="translate(12 ${(mt + H - mb) / 2}) rotate(-90)" text-anchor="middle" class="lbl">Tests passing →</text>`;
    const dots = [...S].sort((a, b) => b.n - a.n).map((s) => {
      const xi = pct(s.impl, s.ops), yi = pct(s.k, s.n);
      return `<a href="#/svc/${s.slug}"><circle class="dot" cx="${x(xi).toFixed(1)}" cy="${y(yi).toFixed(1)}" r="${r(s.n).toFixed(1)}" ${tipAttr(s.title, [["Ops implemented", `${fmt(s.impl)}/${fmt(s.ops)} (${xi.toFixed(0)}%)`], ["Tests passing", `${fmt(s.k)}/${fmt(s.n)} (${yi.toFixed(0)}%)`]])}/></a>`;
    }).join("");
    const label = (sdk) => { const s = S.find((q) => q.sdkId === sdk); if (!s) return ""; const cx = x(pct(s.impl, s.ops)), cy = y(pct(s.k, s.n)); return `<text x="${cx - r(s.n) - 4}" y="${cy + 4}" text-anchor="end" class="lbl" style="font-size:11px;paint-order:stroke;stroke:var(--surface);stroke-width:3px">${esc(sdk)}</text>`; };
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Scatter of implementation share versus test pass rate per service">${g}${dots}${["CloudFormation", "EC2", "S3", "Lambda", "SQS"].map(label).join("")}</svg>`;
  }

  // ------------------------------------------------------------ services table
  let svcSort = { k: "n", d: -1 }, svcQ = "", svcF = "all";
  function services() {
    app.innerHTML = `
      <h1>All services</h1>
      <p class="lede">${fmt(SUM.services.length)} Smithy service models compiled into the emulator. Sort by any column; click a row for detail.</p>
      <div class="card">
        <div class="filters" id="svcF"></div>
        <div class="tbl-wrap"><table id="svcT"></table></div>
      </div>`;
    const cols = [
      ["name", "Service", (s) => short(s).toLowerCase()],
      ["ops", "Ops", (s) => s.ops, "r"],
      ["impl", "Implemented", (s) => pct(s.impl, s.ops), "r"],
      ["stub", "501 stubs", (s) => s.stub, "r"],
      ["cov", "Ops tested", (s) => pct(s.tested, s.ops), "r"],
      ["n", "Tests", (s) => s.n, "r"],
      ["fid", "Pass rate", (s) => (s.n ? pct(s.k, s.n) : -1)],
      ["single", "Single-svc", (s) => (s.ns ? pct(s.ks, s.ns) : -1), "r hide-sm"],
      ["newly", "Fixed since " + SUM.meta.prev, (s) => s.newly, "r hide-sm"],
      ["io", "Open issues", (s) => s.io, "r"],
    ];
    const filters = [["all", "All"], ["scored", "Has tests"], ["unscored", "No tests"], ["stubs", "Has 501 stubs"], ["full", "Fully implemented"]];
    const fn = { all: () => true, scored: (s) => s.n > 0, unscored: (s) => !s.n, stubs: (s) => s.stub > 0, full: (s) => s.impl === s.ops };
    const draw = () => {
      const q = norm(svcQ);
      const S = SUM.services.filter(fn[svcF]).filter((s) => !q || norm(s.sdkId + s.title + s.slug + s.prefix).includes(q));
      const col = cols.find((c) => c[0] === svcSort.k);
      S.sort((a, b) => { const va = col[2](a), vb = col[2](b); return (va < vb ? -1 : va > vb ? 1 : 0) * svcSort.d; });
      document.getElementById("svcF").innerHTML = `<input type="search" id="svcQ" placeholder="Search by name, prefix…" value="${esc(svcQ)}" style="width:240px">` +
        filters.map(([k, l]) => `<button class="fchip ${svcF === k ? "on" : ""}" data-f="${k}">${l}<span class="c">${SUM.services.filter(fn[k]).length}</span></button>`).join("") + `<span class="spacer"></span><span class="small">${S.length} shown</span>`;
      document.getElementById("svcT").innerHTML = `<thead><tr>${cols.map(([k, l, , c]) => `<th class="s ${c || ""}" data-k="${k}">${esc(l)} ${svcSort.k === k ? `<span class="arr">${svcSort.d > 0 ? "↑" : "↓"}</span>` : ""}</th>`).join("")}</tr></thead><tbody>${S.map((s) => `
        <tr class="click" data-slug="${s.slug}">
          <td class="name-cell"><b>${esc(short(s))}</b><span class="small">${esc(s.title)}</span></td>
          <td class="r">${fmt(s.ops)}</td>
          <td class="r">${pctS(s.impl, s.ops)}</td>
          <td class="r">${s.stub ? fmt(s.stub) : `<span class="muted">0</span>`}</td>
          <td class="r">${pctS(s.tested, s.ops)}</td>
          <td class="r">${s.n ? fmt(s.n) : `<span class="muted">0</span>`}</td>
          <td>${s.n ? `<span class="minibar"><span style="width:${pct(s.k, s.n)}%"></span></span>${pctS(s.k, s.n)}` : `<span class="muted">no tests</span>`}</td>
          <td class="r hide-sm">${pctS(s.ks, s.ns)}</td>
          <td class="r hide-sm">${s.newly ? "+" + fmt(s.newly) : `<span class="muted">0</span>`}</td>
          <td class="r">${fmt(s.io)}</td>
        </tr>`).join("")}</tbody>`;
      const qi = document.getElementById("svcQ");
      qi.addEventListener("input", (e) => { svcQ = e.target.value; const pos = e.target.selectionStart; draw(); const n = document.getElementById("svcQ"); n.focus(); n.setSelectionRange(pos, pos); });
    };
    app.addEventListener("click", svcClicks);
    draw();
    function svcClicks(e) {
      if (!document.getElementById("svcT")) return app.removeEventListener("click", svcClicks);
      const th = e.target.closest("th.s"), tr = e.target.closest("tr.click"), f = e.target.closest(".fchip");
      if (th) { const k = th.dataset.k; svcSort = { k, d: svcSort.k === k ? -svcSort.d : k === "name" ? 1 : -1 }; draw(); }
      else if (f) { svcF = f.dataset.f; draw(); }
      else if (tr) location.hash = `#/svc/${tr.dataset.slug}`;
    }
  }

  // ------------------------------------------------------------ service detail
  async function serviceView(slug) {
    const s = bySlug.get(slug);
    if (!s) { app.innerHTML = `<p>Unknown service <code>${esc(slug)}</code>. <a href="#/services">All services</a></p>`; return; }
    app.innerHTML = `<div class="loading">Loading ${esc(s.title)}…</div>`;
    const D = await svcData(slug);
    const T = D.tests;
    const sc = (f) => { const x = T.filter(f); const k = x.filter((t) => t.o === "p").length; return [k, x.filter((t) => t.o !== "s").length]; };
    const crate = `services/service-com-amazonaws-${slug}`;
    const hot = D.ops.filter((o) => o.f1).sort((a, b) => b.f1 - a.f1).slice(0, 8);
    const ops = D.ops;
    const opCount = { all: ops.length, tested: ops.filter((o) => o.s === "impl" && o.t).length, untested: ops.filter((o) => o.s === "impl" && !o.t).length, stub: ops.filter((o) => o.s === "stub").length, failing: ops.filter((o) => o.t && o.p < o.t).length, none: ops.filter((o) => o.s === "skipped" || o.s === "missing").length };

    app.innerHTML = `
      <div class="crumbs"><a href="#/services">Services</a> / ${esc(short(s))}</div>
      <h1>${esc(s.title)}</h1>
      <p class="sub"><span class="chip tag">${esc(s.sdkId)}</span> <span class="chip tag">${esc(D.protocol)}</span> <span class="chip tag">endpoint: ${esc(D.prefix)}</span> <span class="mono muted">${esc(D.shape)}</span> · <a href="${GH_EMU.replace("/blob/", "/tree/")}${crate}">source crate ↗</a></p>
      <div class="kpis">
        <div class="kpi"><div class="v num">${s.n ? pctS(s.k, s.n, 1) : "—"}</div><div class="l">tests pass</div><div class="d">${fmt(s.k)} of ${fmt(s.n)}${s.pn ? ` · was ${pctS(s.pk, s.pn, 1)} in ${esc(SUM.meta.prev)}` : ""}</div></div>
        <div class="kpi"><div class="v num">${s.ns ? pctS(s.ks, s.ns, 1) : "—"}</div><div class="l">single-service tests pass</div><div class="d">${fmt(s.ks)} of ${fmt(s.ns)} test only this service</div></div>
        <div class="kpi"><div class="v num">${fmt(s.impl)}<small>/ ${fmt(s.ops)}</small></div><div class="l">operations implemented</div><div class="d">${fmt(s.stub)} stubs answer 501</div></div>
        <div class="kpi"><div class="v num">${fmt(s.tested)}<small>/ ${fmt(s.ops)}</small></div><div class="l">operations called by a test</div><div class="d">${fmt(s.implUntested)} implemented ops untested</div></div>
        <div class="kpi"><div class="v num">${fmt(s.io)}</div><div class="l">open issues</div><div class="d">${fmt(s.if)} fixed · ${s.sev.C || 0} critical, ${s.sev.H || 0} high</div></div>
      </div>
      <div class="card"><h2>Operations</h2><p class="sub">${fmt(s.ops)} modeled operations by implementation and test status.</p>${segBar(opParts(s))}${legend(opParts(s))}</div>
      <div class="grid2">
        <div class="card"><h2>Pass rate by kind of test</h2><p class="sub">Only kinds this service has tests for.</p><div class="bars">${[
          ["Wire (request replay)", (t) => t.k === "W"], ["Behavioral (SDK program)", (t) => t.k === "B"],
          ["Control plane", (t) => t.pl.includes("control")], ["Data plane", (t) => t.pl.includes("data")],
          ["Happy path", (t) => t.ax === "happy-path"], ["Rejection", (t) => t.ax === "rejection"], ["Negative delivery", (t) => t.ax === "negative-delivery"],
          ["Only this service", (t) => t.n === 1], ["Cross-service", (t) => t.n > 1],
        ].map(([l, f]) => { const [k, n] = sc(f); return n ? passRow(l, k, n) : ""; }).join("") || `<p class="muted">No tests.</p>`}</div></div>
        <div class="card"><h2>Failure hot spots</h2><p class="sub">Operations where request-replay tests stop on their first mismatch.</p><div class="bars">${hot.length ? hot.map((o) => countRow(o.name, o.f1, hot[0].f1, null, `${o.p}/${o.t} tests touching ${o.name} pass`)).join("") : `<p class="muted">No wire-test failures recorded.</p>`}</div>
        ${s.mm && Object.keys(s.mm).length ? `<p class="small" style="margin-top:12px">Mismatch kinds: ${Object.entries(s.mm).map(([k, v]) => `<span class="chip tag">${k} ${v}</span>`).join(" ")}</p>` : ""}</div>
      </div>
      <div class="card" style="margin-top:20px"><h2>Operation list</h2><p class="sub">“Tests” counts tests that call the operation anywhere in their steps; a failure may come from a different call in the same test.</p>
        <div class="filters" id="opF"></div><div class="tbl-wrap"><table id="opT"></table></div><div class="pager" id="opP"></div></div>
      <div class="card"><h2>Fidelity tests</h2><p class="sub">Every scored test touching this service in ${esc(SUM.meta.release)}. Behavioral tests link to their boto3 source.</p>
        <div class="filters" id="tF"></div><div class="tbl-wrap"><table id="tT"></table></div><div class="pager" id="tP"></div></div>
      <div class="card"><h2>Tracked issues</h2><p class="sub">From the repository's <code>issues/</code> folder, filed by the agents that replay tests.</p>
        <div class="filters" id="iF"></div><div class="tbl-wrap"><table id="iT"></table></div><div class="pager" id="iP"></div></div>`;

    // operations table
    let opF = "all", opQ = "", opPage = 0;
    const opFn = { all: () => true, tested: (o) => o.s === "impl" && o.t, untested: (o) => o.s === "impl" && !o.t, stub: (o) => o.s === "stub", failing: (o) => o.t && o.p < o.t, none: (o) => o.s === "skipped" || o.s === "missing" };
    const opLab = { all: "All", tested: "Implemented & tested", untested: "Implemented, no test", stub: "Stub 501", failing: "Has failing tests", none: "Not routable" };
    const drawOps = () => {
      const q = norm(opQ);
      const rows = ops.filter(opFn[opF]).filter((o) => !q || norm(o.name).includes(q));
      const per = 50, pages = Math.max(1, Math.ceil(rows.length / per)); opPage = Math.min(opPage, pages - 1);
      document.getElementById("opF").innerHTML = `<input type="search" id="opQ" placeholder="Find operation…" value="${esc(opQ)}" style="width:200px">` + Object.keys(opFn).filter((k) => opCount[k] || k === "all").map((k) => `<button class="fchip ${opF === k ? "on" : ""}" data-f="${k}">${opLab[k]}<span class="c">${opCount[k]}</span></button>`).join("");
      document.getElementById("opT").innerHTML = `<thead><tr><th>Operation</th><th>Status</th><th class="r">Tests</th><th>Passing</th><th class="hide-sm">Source</th></tr></thead><tbody>${rows.slice(opPage * per, opPage * per + per).map((o) => `
        <tr><td class="mono">${esc(o.name)}</td><td>${opChip(o.s, o.t)}</td><td class="r">${o.t ? fmt(o.t) : `<span class="muted">0</span>`}</td>
        <td>${o.t ? `<span class="minibar"><span style="width:${pct(o.p, o.t)}%"></span></span>${fmt(o.p)}/${fmt(o.t)}` : `<span class="muted">—</span>`}</td>
        <td class="hide-sm"><a class="small" href="${GH_EMU}${crate}/src/ops/${snake(o.name)}.rs">ops/${esc(snake(o.name))}.rs ↗</a></td></tr>`).join("") || `<tr><td colspan="5" class="muted">None.</td></tr>`}</tbody>`;
      pager("opP", opPage, pages, rows.length, (p) => { opPage = p; drawOps(); });
      bindSearch("opQ", (v) => { opQ = v; opPage = 0; drawOps(); });
    };
    document.getElementById("opF").parentElement.addEventListener("click", (e) => { const f = e.target.closest(".fchip"); if (f) { opF = f.dataset.f; opPage = 0; drawOps(); } });
    drawOps();

    // tests table
    const tf = { o: "", k: "", ax: "", pl: "" }; let tQ = "", tPage = 0;
    const facets = [["o", "Outcome", { p: "pass", f: "fail", s: "skipped" }], ["k", "Kind", { W: "wire", B: "behavioral" }], ["ax", "Axis", { "happy-path": "happy path", rejection: "rejection", "negative-delivery": "negative delivery" }], ["pl", "Plane", { control: "control", data: "data" }]];
    const tMatch = (t, skip) => facets.every(([key]) => key === skip || !tf[key] || (key === "pl" ? t.pl.includes(tf[key]) : t[key] === tf[key]));
    const drawTests = () => {
      const q = norm(tQ);
      const rows = T.filter((t) => tMatch(t)).filter((t) => !q || norm(t.id + (t.op || "") + t.svcs.join("")).includes(q));
      const per = 50, pages = Math.max(1, Math.ceil(rows.length / per)); tPage = Math.min(tPage, pages - 1);
      document.getElementById("tF").innerHTML = `<input type="search" id="tQ" placeholder="Search test id / op…" value="${esc(tQ)}" style="width:200px">` + facets.map(([key, , vals]) => Object.entries(vals).map(([v, l]) => { const c = T.filter((t) => tMatch(t, key) && (key === "pl" ? t.pl.includes(v) : t[key] === v)).length; return c || tf[key] === v ? `<button class="fchip ${tf[key] === v ? "on" : ""}" data-key="${key}" data-v="${v}">${l}<span class="c">${fmt(c)}</span></button>` : ""; }).join("")).join(`<span class="muted">·</span>`);
      document.getElementById("tT").innerHTML = `<thead><tr><th>Test</th><th>Result</th><th class="hide-sm">Labels</th><th>Where it differed</th></tr></thead><tbody>${rows.slice(tPage * per, tPage * per + per).map((t) => {
        const src = t.path ? `<a href="${GH_SUITE}${esc(t.path)}">${esc(t.id)}</a>` : `<span class="mono">${esc(t.id)}</span>`;
        const diff = t.mm ? `<span class="chip tag">${esc(t.mm)}</span> <span class="mono">${esc(t.op)}</span>${t.ex && t.mm === "status" ? ` <span class="small">AWS ${esc(t.ex.status)}${t.ex.errorCode && !t.ex.errorCode.startsWith("<") ? " " + esc(t.ex.errorCode) : ""} → emu ${esc(t.ac?.status)}${t.ac?.errorCode ? " " + esc(t.ac.errorCode) : ""}</span>` : ""}` : t.cause ? `<span class="small">${esc(t.cause)}</span>` : "";
        const flip = t.prev === "f" && t.o === "p" ? ` <span class="chip tag" title="failed in ${esc(SUM.meta.prev)}">newly passing</span>` : t.prev === "p" && t.o === "f" ? ` <span class="chip tag">regressed</span>` : "";
        return `<tr><td style="max-width:420px;word-break:break-word">${src}${t.n > 1 ? `<div class="small muted">with ${esc(t.svcs.filter((x) => x !== slug).map((x) => bySlug.get(x) ? short(bySlug.get(x)) : x).join(", "))}</div>` : ""}</td>
          <td>${passChip(t.o)}${flip}</td><td class="hide-sm"><span class="small">${t.k === "W" ? "wire" : "behavioral"}${t.ax ? " · " + esc(t.ax) : ""}${t.pl ? " · " + esc(t.pl) : ""}${t.dp ? " · " + esc(t.dp) : ""}</span></td><td>${diff}</td></tr>`;
      }).join("") || `<tr><td colspan="4" class="muted">No tests match.</td></tr>`}</tbody>`;
      pager("tP", tPage, pages, rows.length, (p) => { tPage = p; drawTests(); });
      bindSearch("tQ", (v) => { tQ = v; tPage = 0; drawTests(); });
    };
    document.getElementById("tF").addEventListener("click", (e) => { const f = e.target.closest(".fchip"); if (f) { tf[f.dataset.key] = tf[f.dataset.key] === f.dataset.v ? "" : f.dataset.v; tPage = 0; drawTests(); } });
    drawTests();

    // issues
    let iF = "o", iPage = 0;
    const drawIssues = () => {
      const rows = D.issues.filter((i) => !iF || i.st === iF);
      const per = 25, pages = Math.max(1, Math.ceil(rows.length / per)); iPage = Math.min(iPage, pages - 1);
      document.getElementById("iF").innerHTML = [["o", "Open"], ["f", "Fixed"], ["", "All"]].map(([v, l]) => `<button class="fchip ${iF === v ? "on" : ""}" data-v="${v}">${l}<span class="c">${D.issues.filter((i) => !v || i.st === v).length}</span></button>`).join("");
      document.getElementById("iT").innerHTML = `<thead><tr><th>Filed</th><th>Severity</th><th>Issue</th><th class="hide-sm">State</th></tr></thead><tbody>${rows.slice(iPage * per, iPage * per + per).map((i) => `
        <tr><td class="small" style="white-space:nowrap">${i.f.slice(0, 4)}-${i.f.slice(4, 6)}-${i.f.slice(6, 8)}</td><td>${sevChip(i.sev)}</td>
        <td><a href="${GH_EMU}issues/${i.st === "o" ? "things-that-do-not-work" : "things-that-now-work"}/${encodeURIComponent(i.f)}">${esc(i.t || i.f)}</a></td>
        <td class="hide-sm">${i.st === "o" ? `<span class="chip crit">open</span>` : `<span class="chip good">fixed</span>`}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No issues.</td></tr>`}</tbody>`;
      pager("iP", iPage, pages, rows.length, (p) => { iPage = p; drawIssues(); });
    };
    document.getElementById("iF").addEventListener("click", (e) => { const f = e.target.closest(".fchip"); if (f) { iF = f.dataset.v; iPage = 0; drawIssues(); } });
    drawIssues();
  }

  function bindSearch(id, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", (e) => { const v = e.target.value, pos = e.target.selectionStart; fn(v); const n = document.getElementById(id); n.focus(); n.setSelectionRange(pos, pos); });
  }
  function pager(id, page, pages, total, go) {
    const el = document.getElementById(id);
    if (pages <= 1) { el.innerHTML = total ? `<span>${fmt(total)} rows</span>` : ""; return; }
    el.innerHTML = `<span>${fmt(total)} rows · page ${page + 1} of ${pages}</span><button class="btn" data-p="${page - 1}" ${page ? "" : "disabled"}>← Prev</button><button class="btn" data-p="${page + 1}" ${page < pages - 1 ? "" : "disabled"}>Next →</button>`;
    el.onclick = (e) => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) go(+b.dataset.p); };
  }

  // ------------------------------------------------------------ project checker
  const EXAMPLE = `# One per line. Any of these formats work:
s3:PutObject
s3:GetObject
aws s3api list-objects-v2 --bucket demo
aws sqs send-message --queue-url ...
sqs.receive_message
dynamodb:Query, dynamodb:TransactWriteItems
lambda:Invoke
events:PutEvents
states:StartExecution
cloudformation:CreateStack
athena:StartQueryExecution
ssm:GetParameter
kms:Decrypt`;
  const EXTRA_ALIAS = { s3api: "s3", "elbv2": "elasticloadbalancing", "stepfunctions": "states", "cognito-identity-provider": "cognito-idp", "cloudwatch-logs": "logs" };

  function parseOps(text) {
    const out = [];
    for (let line of text.split("\n")) {
      line = line.replace(/#.*$/, "").trim();
      if (!line) continue;
      let m = line.match(/^aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/i);
      if (m) { out.push({ raw: line, svc: m[1], op: m[2] }); continue; }
      for (const part of line.split(/[,;\s]+/).filter(Boolean)) {
        m = part.match(/^["']?([a-z0-9-]+)[:.]([A-Za-z0-9_*-]+)["']?$/i);
        if (m) out.push({ raw: part, svc: m[1], op: m[2] });
        else if (/^[A-Za-z][A-Za-z0-9_]+$/.test(part)) out.push({ raw: part, svc: "", op: part });
      }
    }
    return out;
  }
  function resolveOp(q) {
    const svcKey = (q.svc || "").toLowerCase();
    const a = IDX.aliases;
    let cands = a[svcKey] || a[EXTRA_ALIAS[svcKey]] || [];
    if (!cands.length && svcKey) cands = Object.keys(IDX.svc).filter((sl) => sl.startsWith(svcKey.replace(/-/g, "")));
    const target = norm(q.op);
    const find = (slugs) => { let best = null; for (const sl of slugs) { const ops = IDX.svc[sl].ops; for (const name in ops) if (norm(name) === target && (!best || ops[name][1] > best.v[1])) best = { sl, name, v: ops[name] }; } return best; };
    let hit = find(cands);
    if (!hit && !svcKey) { const all = []; for (const sl in IDX.svc) for (const name in IDX.svc[sl].ops) if (norm(name) === target) all.push({ sl, name, v: IDX.svc[sl].ops[name] }); if (all.length === 1) hit = all[0]; else if (all.length > 1) return { ambiguous: all.map((x) => x.sl) }; }
    return hit;
  }
  function verdict(hit) {
    if (!hit || hit.ambiguous) return { c: "unk", chip: `<span class="chip neutral">not found</span>`, l: "Not found" };
    const [s, t, p] = hit.v;
    if (s === "s") return { c: "stub", chip: `<span class="chip crit">stub · 501</span>`, l: "Not implemented" };
    if (s !== "i") return { c: "stub", chip: `<span class="chip crit">not routable</span>`, l: "Not implemented" };
    if (!t) return { c: "untested", chip: `<span class="chip warn">implemented · untested</span>`, l: "Untested" };
    const r = p / t;
    if (r >= 0.8) return { c: "good", chip: `<span class="chip good">mostly passing</span>`, l: "Verified" };
    if (r >= 0.5) return { c: "mixed", chip: `<span class="chip warn">mixed results</span>`, l: "Mixed" };
    return { c: "partial", chip: `<span class="chip ser">mostly failing</span>`, l: "Mostly failing" };
  }

  async function checkView(params) {
    const init = params.get("ops") || "";
    app.innerHTML = `
      <h1>Check my project</h1>
      <p class="lede">Paste the AWS operations your code or IaC calls. Each is matched against the emulator's operation census and the fidelity tests that exercise it, following AWS's own <a href="https://docs.aws.amazon.com/emulator/latest/userguide/check-project.html">check-project workflow</a>.</p>
      <div class="card">
        <label for="ops" class="small">IAM-style <code>svc:Operation</code>, CLI commands (<code>aws s3api put-object</code>), boto3 (<code>sqs.send_message</code>) or bare operation names.</label>
        <textarea id="ops" spellcheck="false" placeholder="s3:PutObject">${esc(init)}</textarea>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="go">Check operations</button><button class="btn" id="ex">Load example</button><button class="btn" id="share">Copy shareable link</button><span class="spacer"></span><span class="small muted" id="msg"></span></div>
      </div>
      <div id="res"></div>`;
    document.getElementById("ex").onclick = () => { document.getElementById("ops").value = EXAMPLE; run(); };
    document.getElementById("go").onclick = run;
    document.getElementById("share").onclick = async () => {
      const url = location.href.split("#")[0] + "#/check?ops=" + encodeURIComponent(document.getElementById("ops").value);
      try { await navigator.clipboard.writeText(url); document.getElementById("msg").textContent = "Link copied"; } catch (_) { document.getElementById("msg").textContent = url; }
    };
    if (!IDX) { document.getElementById("msg").textContent = "Loading operation index…"; IDX = await getJSON("data/ops-index.json"); document.getElementById("msg").textContent = ""; }
    if (init) run();

    function run() {
      const text = document.getElementById("ops").value;
      const qs = parseOps(text);
      const rows = qs.map((q) => ({ q, hit: resolveOp(q) })).map((r) => ({ ...r, v: verdict(r.hit) }));
      const cnt = (c) => rows.filter((r) => r.v.c === c).length;
      const box = (c, l, cls) => `<div class="vbox"><b class="num">${cnt(c)}</b><span>${l}</span></div>`;
      document.getElementById("res").innerHTML = !rows.length ? `<p class="muted">No operations recognised.</p>` : `
        <div class="card">
          <div class="row"><h2>${fmt(rows.length)} operations checked</h2></div>
          <div class="verdicts">${box("good", "≥ 80% of tests calling it pass")}${box("mixed", "50–80% of tests pass")}${box("partial", "< 50% of tests pass")}${box("untested", "Implemented, no fidelity test")}${box("stub", "Not implemented (501 / unroutable)")}${box("unk", "Not found in any model")}</div>
          <div class="tbl-wrap"><table><thead><tr><th>You wrote</th><th>Resolved to</th><th>Verdict</th><th>Tests passing</th></tr></thead><tbody>
          ${rows.map(({ q, hit, v }) => `<tr><td class="mono">${esc(q.raw)}</td>
            <td>${hit && !hit.ambiguous ? `<a href="#/svc/${hit.sl}">${esc(short(bySlug.get(hit.sl)))}</a> <span class="mono">${esc(hit.name)}</span>` : hit?.ambiguous ? `<span class="small">ambiguous: add a service prefix (${esc(hit.ambiguous.slice(0, 4).map((x) => short(bySlug.get(x))).join(", "))}…)</span>` : `<span class="muted">—</span>`}</td>
            <td>${v.chip}</td>
            <td>${hit && !hit.ambiguous && hit.v[1] ? `<span class="minibar"><span style="width:${pct(hit.v[2], hit.v[1])}%"></span></span>${fmt(hit.v[2])}/${fmt(hit.v[1])}` : `<span class="muted">—</span>`}</td></tr>`).join("")}
          </tbody></table></div>
          <p class="small muted" style="margin:12px 0 0">A test counts for an operation when it calls the operation and is scored for that service. Many are multi-step workflows, so a failure may come from another call in the same test; open the service to see which tests fail and where. “Mostly passing” means the emulator matched AWS in the scenarios AWS chose to test, not every parameter combination. For anything untested, AWS recommends running your own test against both the emulator and real AWS.</p>
        </div>`;
    }
  }

  // ------------------------------------------------------------ issues view
  function issuesView() {
    const M = SUM.meta;
    const sev = (st, s) => M.issueSev[`${st}|${s}`] || 0;
    const cat = (st, c) => M.issueCat[`${st}|${c}`] || 0;
    const openT = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].reduce((a, s) => a + sev("open", s), 0);
    const fixedT = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "?"].reduce((a, s) => a + sev("fixed", s), 0);
    const top = [...SUM.services].sort((a, b) => b.io - a.io).slice(0, 16);
    const stubs = [...SUM.services].sort((a, b) => b.stub - a.stub).slice(0, 16);
    app.innerHTML = `
      <h1>Gaps &amp; issues</h1>
      <p class="lede">The repository tracks every known divergence as a Markdown file. Agents replay tests, file an issue per root cause, and move it to <code>things-that-now-work/</code> when a fix lands. The repo takes no pull requests.</p>
      <div class="kpis">
        <div class="kpi"><div class="v num">${fmt(openT)}</div><div class="l">open issues</div><div class="d">${fmt(sev("open", "CRITICAL"))} critical · ${fmt(sev("open", "HIGH"))} high</div></div>
        <div class="kpi"><div class="v num">${fmt(fixedT)}</div><div class="l">fixed so far</div><div class="d">${pctS(fixedT, fixedT + openT)} of all filed</div></div>
        <div class="kpi"><div class="v num">${fmt(cat("open", "stub"))}</div><div class="l">open “implement this stub” issues</div><div class="d">operation answers 501</div></div>
        <div class="kpi"><div class="v num">${fmt(cat("open", "wrong-behavior"))}</div><div class="l">open “wrong behavior” issues</div><div class="d">implemented but diverges</div></div>
        <div class="kpi"><div class="v num">${fmt(SUM.services.reduce((a, s) => a + s.stub, 0))}</div><div class="l">stub operations in source</div><div class="d">most have no issue: no test calls them</div></div>
      </div>
      <div class="card"><h2>Issues filed per day</h2><p class="sub">By the date in each issue's file name, split by whether it is fixed yet. The agent fleet has filed up to ~3,000 a day; most October issues are already fixed, most November ones are still open.</p><div id="tl"></div>
        <div class="legend"><span><i style="background:var(--op-tested)"></i>Since fixed</span><span><i style="background:var(--op-stub)"></i>Still open</span></div></div>
      <div class="grid2">
        <div class="card"><h2>Most open issues</h2><p class="sub">Issues mapped to a single service model.</p><div class="bars">${top.map((s) => countRow(short(s), s.io, top[0].io, `#/svc/${s.slug}`, `${s.sev.C || 0} critical · ${s.sev.H || 0} high · ${s.if} fixed`)).join("")}</div></div>
        <div class="card"><h2>Most 501 stubs</h2><p class="sub">Modeled operations that only return NotImplemented.</p><div class="bars">${stubs.map((s) => countRow(short(s), s.stub, stubs[0].stub, `#/svc/${s.slug}`, `${s.impl}/${s.ops} implemented`)).join("")}</div></div>
      </div>
      <div class="card" style="margin-top:20px"><h2>Severity of open vs fixed</h2><p class="sub">Severity as recorded in each issue's header.</p><div class="bars">
        ${["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => passRow(s[0] + s.slice(1).toLowerCase(), sev("fixed", s), sev("fixed", s) + sev("open", s), null, "Bar = share already fixed")).join("")}
      </div><p class="small muted" style="margin:10px 0 0">Bars show the share of each severity that is already fixed.</p></div>`;
    drawTimeline();
  }
  function drawTimeline() {
    const el = document.getElementById("tl");
    const days = Object.entries(SUM.meta.issueDays).filter(([d]) => d >= "20260901");
    const W = Math.max(320, el.clientWidth || 900), H = 220, ml = 44, mr = 8, mt = 8, mb = 26;
    const max = Math.max(...days.map(([, v]) => v[0] + v[1]));
    const nice = Math.ceil(max / 500) * 500;
    const bw = (W - ml - mr) / days.length;
    const y = (v) => mt + (1 - v / nice) * (H - mt - mb);
    let g = "";
    for (let t = 0; t <= nice; t += nice / 4) g += `<line class="gl" x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}"/><text x="${ml - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
    days.forEach(([d, [o, f]], i) => {
      const x = ml + i * bw + Math.max(0.5, bw * 0.12), w = Math.max(1, bw * 0.76);
      const yf = y(f), yo = y(f + o);
      const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
      if (f) g += `<rect x="${x}" y="${yf}" width="${w}" height="${y(0) - yf}" fill="var(--op-tested)" rx="1"/>`;
      if (o) g += `<rect x="${x}" y="${yo}" width="${w}" height="${Math.max(0, yf - yo - (f ? 1 : 0))}" fill="var(--op-stub)" rx="1"/>`;
      g += `<rect class="hit" x="${ml + i * bw}" y="${mt}" width="${bw}" height="${H - mt - mb}" ${tipAttr(date, [["Filed", fmt(o + f)], ["Since fixed", fmt(f)], ["Still open", fmt(o)]])}/>`;
      if (i % Math.ceil(days.length / 8) === 0) g += `<text x="${ml + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${new Date(date + "T00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</text>`;
    });
    g += `<line class="ax" x1="${ml}" x2="${W - mr}" y1="${y(0)}" y2="${y(0)}"/>`;
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Issues filed per day">${g}</svg>`;
  }

  // ------------------------------------------------------------ about
  function about() {
    const M = SUM.meta;
    app.innerHTML = `<div class="prose">
      <h1>About this release, and this atlas</h1>
      <p class="lede">AWS Emulator went generally available on 11 November 2026. This page sums up what it is, what it does not do, and how the numbers on this site are built.</p>

      <h2>What AWS shipped</h2>
      <ul>
        <li>A <strong>local emulator of the AWS APIs</strong> written in Rust. It serves HTTPS on <code>127.0.0.1:9297</code>, and you point the AWS CLI or any SDK at it with environment variables. It needs no AWS account and has no service fee. <a href="https://aws.amazon.com/blogs/aws/test-your-applications-against-aws-locally-with-aws-emulator/">AWS News Blog</a></li>
        <li>Installs as an RPM or Debian package on Linux. On macOS and Windows you build a Docker image from the documented Dockerfile; AWS publishes no prebuilt image. An <strong>embedded mode</strong> compiles it into Rust test binaries.</li>
        <li><strong>Generated from AWS's published Smithy API models</strong>: one crate per service, one file per operation. This build has ${fmt(M.services)} service models and ${fmt(M.ops.impl + M.ops.stub + M.ops.skipped)} operations.</li>
        <li><strong>Written entirely by autonomous AI agents</strong>. Humans wrote the specifications, the tests and the release pipeline. Agent teams write tests against real AWS, replay them to find divergences, and fix them. <a href="https://www.aboutamazon.com/news/aws/how-autonomous-ai-agents-built-aws-emulator">About Amazon</a></li>
        <li>Licensed <strong>CC0</strong> (vendor crates Apache-2.0). The repo takes no pull requests; report gaps as GitHub issues.</li>
      </ul>

      <h2>What it does not do</h2>
      <ul>
        <li><strong>No real IAM evaluation.</strong> It does not evaluate IAM or resource-based policies the way AWS does, so don't use it for security testing. An independent test found 5 of 32 permission cases allowed requests that AWS denies. <a href="https://devops-daily.com/posts/aws-emulator-hands-on-test">DevOps Daily</a></li>
        <li><strong>No persistence.</strong> State is in memory and lost when the process stops.</li>
        <li><strong>One account, one Region.</strong> It accepts any account ID or Region but keeps no separation between them, so there is no cross-account or cross-Region behaviour.</li>
        <li><strong>Not for production, load or long-running use.</strong> AWS hasn't tested it for those.</li>
        <li><strong>No native engines.</strong> Database, cache and broker wire protocols are almost entirely unemulated: <b>${fmt(M.labels["dp:native"]?.pass || 0)}</b> of ${fmt((M.labels["dp:native"]?.pass || 0) + (M.labels["dp:native"]?.fail || 0))} native-protocol tests pass.</li>
        <li><strong>${fmt(M.ops.stub)} stubbed operations</strong> answer <code>501 NotImplemented</code>, and ${fmt(M.ops.skipped)} more are modeled but not routable.</li>
        <li><strong>Telemetry is on by default.</strong> Turn it off with <code>--telemetry off</code>, <code>EMULATOR_TELEMETRY=off</code>, or <code>[telemetry] enabled = false</code> in <code>~/.aws/emulator/config.toml</code>.</li>
        <li>Community reports at launch: some JS SDK v3 SQS calls go to the real AWS endpoint unless <code>useQueueUrlAsEndpoint: false</code> is set; Terraform AWS provider 6.x fails on <code>aws_s3_bucket</code> while 5.100 works; inline Lambda code and Function URL permissions fail; returned URLs use real AWS hostnames; it adds caps AWS doesn't have (64 MiB per bucket, 1,000 messages per queue). <a href="https://dev.to/aws-builders/aws-how-far-can-cdkterraform-stacks-run-on-aws-emulator-awsemulator-56dm">DEV</a>, <a href="https://devops-daily.com/posts/aws-emulator-hands-on-test">DevOps Daily</a></li>
      </ul>

      <h2>How fidelity is measured</h2>
      <p>A fidelity test is a program that runs against real AWS (us-west-2, or us-east-1 for global services) and against the emulator, and asserts the same result, resulting state and exact error. A service's score is <strong>k of n</strong>: k of its n tests pass. AWS publishes the failing tests on purpose. Scores are snapshots: a passing test should not regress, but n changes as tests are added or retired, so <strong>compare scores only within the same test-suite version</strong>. <a href="https://docs.aws.amazon.com/emulator/latest/userguide/fidelity.html">Fidelity in AWS Emulator</a></p>
      <p>The release's <code>scores.json</code> contains two kinds of unit:</p>
      <ul>
        <li><strong>Behavioral</strong> (${fmt(M.kinds.behavioral.pass + M.kinds.behavioral.fail + (M.kinds.behavioral.skipped || 0))}): boto3 programs in <a href="https://github.com/aws/aws-emulator-evaluation-suite">aws-emulator-evaluation-suite</a>, labelled by plane (control / data), data-plane path (API / endpoint / native), axis (happy path / rejection / negative delivery) and timing.</li>
        <li><strong>Wire</strong> (${fmt(M.kinds.wire.pass + M.kinds.wire.fail)}): recorded AWS HTTP exchanges replayed step by step. The first mismatch in status, body or headers fails the unit. These are not in the public manifest; their operations come from the recorded steps.</li>
      </ul>

      <h2>How this atlas computes things</h2>
      <ul>
        <li><strong>Sources:</strong> <code>scores.json.gz</code> from release <a href="https://github.com/aws/aws-emulator/releases/tag/${esc(M.release)}">${esc(M.release)}</a> (compared with ${esc(M.prev)}), <code>manifest.jsonl</code> at the evaluation suite's HEAD (${fmt(M.manifestRows)} rows), and the emulator source tree and <code>issues/</code> at the <code>${esc(M.release)}</code> tag, so stubs and issues describe the scored commit.</li>
        <li><strong>Updates:</strong> a GitHub Actions job checks AWS's releases every 6 hours and rebuilds the site when a new scored release appears. Last rebuild: ${M.builtAt ? new Date(M.builtAt).toUTCString().slice(5, 22) + " UTC" : "n/a"}.</li>
        <li><strong>Operation status</strong> comes from the source tree. Every operation bound to the service shape in its Smithy model is checked against <code>src/ops/&lt;op&gt;.rs</code>. A file headed <code>//! SCAFFOLDED, NOT IMPLEMENTED</code> is a stub; ops listed in <code>SKIPPED_STUBS.md</code>, or with no file, are “not routable”.</li>
        <li><strong>Service scores</strong> count every unit that lists the service, so cross-service tests count against each service involved. “Single-service” keeps only units that touch one service.</li>
        <li><strong>Operation test counts</strong> attribute a behavioral test to every operation in its manifest row, and a wire test to every operation in its recorded steps, counting only services the unit is scored for. Manifest prefixes (e.g. <code>cognito-idp</code>) are mapped to Smithy shapes by learning from single-service units.</li>
        <li>About ${fmt(M.units - M.manifestRows - M.kinds.wire.pass - M.kinds.wire.fail > 0 ? M.units - M.manifestRows - M.kinds.wire.pass - M.kinds.wire.fail : 0)} behavioral units (smoke tests, tests renamed since scoring) have no manifest row. They count toward service scores but carry no labels or operations.</li>
        <li>Issues are mapped to a service by their <code>Issue-Shape-Id</code> header. Cross-service issues without one appear only in the global totals.</li>
      </ul>
      <div class="note">Independent project, not affiliated with AWS. Data and code are rebuilt from public repositories; see <a href="https://github.com/englishcompiler/aws-emulator-atlas">the source</a>.</div>
    </div>`;
  }

  // ------------------------------------------------------------ boot
  (async () => {
    try {
      SUM = await getJSON("data/summary.json");
      SUM.services.forEach((s) => bySlug.set(s.slug, s));
      const M = SUM.meta;
      document.getElementById("foot").innerHTML = `Data: <a href="https://github.com/aws/aws-emulator/releases/tag/${esc(M.release)}">AWS Emulator ${esc(M.release)}</a> scores, <a href="https://github.com/aws/aws-emulator-evaluation-suite">evaluation suite</a> manifest, source &amp; <code>issues/</code> at <a href="https://github.com/aws/aws-emulator/commit/${M.commit}">${M.commit.slice(0, 7)}</a>. Rebuilt automatically when AWS publishes a scored release${M.builtAt ? ` · last rebuild ${new Date(M.builtAt).toUTCString().slice(5, 22)} UTC` : ""}. Independent project, not affiliated with AWS. · <a href="https://github.com/englishcompiler/aws-emulator-atlas">Source</a>`;
      route();
    } catch (e) {
      app.innerHTML = `<p>Could not load data: ${esc(e.message)}</p>`;
    }
  })();
  let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (document.getElementById("scatter")) drawScatter(); if (document.getElementById("tl")) drawTimeline(); }, 150); });
})();
