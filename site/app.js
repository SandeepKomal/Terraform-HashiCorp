// DevOps Nimbus Terraform site. No dependencies, no network requests.
"use strict";

(function () {
  const Q = window.TRACK;
  const $ = (sel) => document.querySelector(sel);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollToEl = (el) => el.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });

  // h("tag.class", {attr: value}, ...children): build DOM from elements and text nodes only.
  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(" ");
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // Text with `code` spans.
  function rich(text) {
    return String(text).split(/(`[^`]+`)/).map((part) => (part.startsWith("`") ? h("code", null, part.slice(1, -1)) : part));
  }

  const PREFIX = "dq-terraform:";
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode */ } }
  };
  function forgetEverything() {
    if (!confirm("Clear your progress, quiz scores and saved names from this browser?")) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); } catch { /* storage blocked */ }
    location.reload();
  }

  // The first screen needs only data.js, scenarios.js (a small index of the
  // playground's incidents), this file and engage.js. The rest loads in the
  // background after the first paint, or at once when something needs it.
  const LAZY = { quiz: ["quiz-bank.js"], xray: ["hcl.js", "xray.js"], play: ["hcl.js", "playground.js"], arch: ["architecture.js"] };
  const loading = {};
  function loadScript(src) {
    if (!loading[src]) {
      loading[src] = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = false; // run in the order they were added
        el.onload = resolve;
        el.onerror = () => { delete loading[src]; el.remove(); reject(new Error("Could not load " + src)); };
        document.body.append(el);
      });
    }
    return loading[src];
  }
  const load = (srcs) => Promise.all(srcs.map(loadScript));
  // What to draw once a feature's scripts have run (set further down).
  const ready = {};
  const needed = {};
  const need = (what) => (needed[what] = needed[what] || load(LAZY[what]).then(() => { if (ready[what]) ready[what](); }, (e) => { delete needed[what]; throw e; }));
  const warm = () => Promise.all(Object.keys(LAZY).map(need));

  const SCENARIOS = window.TRACK_SCENARIOS || [];
  const pg = () => window.TQPlayground;
  const titles = () => Object.fromEntries(SCENARIOS.map((x) => [x.id, x.title]));
  // Run something in the playground once it has loaded.
  const withPg = (fn) => (pg() ? fn(pg()) : need("play").then(() => fn(pg())));
  // Open a scenario: through the address bar, so every scenario has a link.
  const practise = (id) => {
    if (location.hash === "#play/" + id) { show(); withPg((p) => p.load(id)); } else location.hash = "play/" + id;
  };
  const exampleUrl = (lv) => (lv.example ? `${Q.repo}/tree/main/${lv.example}` : null);

  document.querySelectorAll("[data-repo]").forEach((a) => { a.href = Q.repo + a.dataset.repo; });

  // Copy a deep link to the clipboard; the button says what happened.
  function copyLink(hash, btn) {
    const url = location.href.split("#")[0] + "#" + hash;
    const say = (t) => { btn.textContent = t; setTimeout(() => { btn.textContent = "Copy link"; }, 1400); };
    navigator.clipboard.writeText(url).then(() => say("Link copied"), () => say("Copy failed"));
  }

  // --- tabs and deep links ----------------------------------------------------

  const tabs = ["path", "quiz", "xray", "doctor", "cheats", "arch"];
  let current = null;
  function show() {
    const [want, sub] = location.hash.slice(1).split("/");
    const tab = want === "play" ? "path" : want === "fix" ? "doctor" : tabs.includes(want) ? want : "path";
    if (tab !== current) {
      const page = $("#tab-" + tab);
      page.classList.remove("tab-in");
      void page.offsetWidth; // restart the fade
      page.classList.add("tab-in");
    }
    current = tab;
    if (LAZY[tab]) need(tab);
    if (tab !== "path" && flowTimer) stopFlow();
    for (const t of tabs) $("#tab-" + t).hidden = t !== tab;
    const fixTabs = [...document.querySelectorAll(".mode.fix a[data-tab]")].map((a) => a.dataset.tab);
    const mode = fixTabs.includes(tab) ? "fix" : "learn";
    document.documentElement.dataset.mode = mode;
    document.querySelectorAll(".sw").forEach((a) => (a.classList.contains(mode) ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
    document.querySelectorAll(".subnav a").forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (want === "play" && sub && titles()[sub]) {
      if (!pg()) need("play").then(show);
      else if (pg().current() !== sub || !document.activeElement || document.activeElement.id !== "pg-input") pg().load(sub);
    }
    if (want === "fix" && sub) { const i = Q.problems.findIndex((d) => d.id === sub); if (i >= 0) renderProblem(i, true); }
  }
  window.addEventListener("hashchange", () => {
    const before = current;
    show();
    if (current !== before && !/^#(play|fix)\//.test(location.hash)) window.scrollTo(0, 0);
  });

  // --- landing ------------------------------------------------------------------

  // The track's signature: a plan that would replace the database, and the fix.
  function renderSignature() {
    const stage = $("#signature");
    const plan = h("div.plan.mono");
    const summary = h("div.summary.mono");
    const sp = (cls, text) => h("span." + cls, null, text);
    const draw = (fixed) => {
      plan.replaceChildren(...[
        h("div", null, sp("s-warn", "  ~ "), "aws_security_group.web ", sp("s-dim", "ingress 443")),
        fixed ? h("div", null, sp("s-warn", "  ~ "), "aws_db_instance.orders ", sp("s-dim", "tags.Owner = \"platform\"")) : null,
        fixed
          ? h("div.pin", null, sp("s-ok", "    "), "lifecycle { prevent_destroy = true }")
          : h("div.replace", null, sp("s-bad", "-/+ "), "aws_db_instance.orders ", sp("s-bad", "identifier # forces replacement"))].filter(Boolean));
      summary.replaceChildren(fixed
        ? h("span", null, "Plan: 0 to add, 2 to change, ", sp("s-ok", "0 to destroy"), ".")
        : h("span", null, "Plan: 1 to add, 1 to change, ", sp("s-bad", "1 to destroy"), ". The orders database, with its data."));
    };
    const toggle = h("button.toggle", { type: "button", "aria-pressed": "false" }, "Keep the identifier, add prevent_destroy");
    toggle.addEventListener("click", () => {
      const on = toggle.getAttribute("aria-pressed") !== "true";
      toggle.setAttribute("aria-pressed", String(on));
      draw(on);
    });
    stage.replaceChildren(
      h("div.stage-bar", null, h("div", null, h("strong", null, "terraform plan"), "A naming pull request, read before apply."), toggle),
      plan, summary,
      h("p.stage-foot.s-dim", null, "Fix it yourself: ", h("a", { href: "#play/dbreplace" }, "A rename that replaces the database")));
    draw(false);
  }

  function renderLanding() {
    const n = SCENARIOS.length;
    $("#stats").replaceChildren(...[[String(n), "incidents to fix, basics to production"], [String(Q.levels.length), "levels"], ["$0", "cloud bill: the cloud is simulated"]]
      .map(([b, s]) => h("div", null, h("b", null, b), h("span", null, s))));
    const tiles = [
      ["#play/noinit", "Playground", "init, plan, apply, state, import.", "Locked state, drift, replacements you did not expect, version conflicts.", "wide"],
      ["#xray", "HCL X-ray", "Every block, explained.", "Paste a .tf file: what each line does, and the risky defaults flagged.", "wide"],
      ["#quiz", "Quiz", "State is everything.", "Questions with the reasoning."],
      ["#arch", "How apply works", "Core, providers, state.", "Who talks to whom on apply."],
      ["#doctor", "Stuck on an error?", "Learn why it happens, then practise the fix.", `${Q.problems.length} errors, each with cause, fix and prevention.`]
    ];
    $("#bento").replaceChildren(...tiles.map(([href, k, title, text, size]) => h("a.tile" + (size ? "." + size : ""), { href },
      h("div", null, h("div.k", null, k), h("h3", null, title)), h("p", null, text))));
  }

  // --- path ----------------------------------------------------------------

  const stageId = (name) => "stage-" + name.toLowerCase().replace(/\s+/g, "-");
  function renderPath() {
    const done = new Set(store.get("done", []));
    const solved = new Set(store.get("pg-solved", []));
    const box = $("#levels");
    box.replaceChildren();
    const names = titles();
    let stage = "";
    let list;
    for (const lv of Q.levels) {
      if (lv.stage !== stage) {
        stage = lv.stage;
        list = h("ol.levels");
        box.append(h("h3.stage-title", { id: stageId(stage) }, stage), list);
      }
      const isDone = done.has(lv.id);
      const ex = exampleUrl(lv);
      list.append(h("li.level" + (isDone ? ".done" : ""), { id: "lv-" + lv.id },
        h("input", {
          type: "checkbox", checked: isDone, "aria-label": `Mark level ${lv.id} complete`,
          onchange: (e) => { if (e.target.checked) done.add(lv.id); else done.delete(lv.id); store.set("done", [...done]); if (e.target.checked) window.TQEngage.active(); renderPath(); }
        }),
        h("span.num", null, lv.id),
        h("span.what", null,
          h("strong", null, lv.title),
          h("span.topic", null, lv.topic),
          h("span.learn", null, lv.learn),
          h("span.level-labs", null, h("span.muted.small", null, "Lab:"),
            lv.lab.filter((id) => names[id]).map((id) => h("button.chip", { type: "button", onclick: () => practise(id), title: solved.has(id) ? "Solved" : "Open in the playground" }, (solved.has(id) ? "✓ " : "") + names[id])),
            ex ? h("a.small", { href: ex }, `Example: ${lv.example}`) : null,
            h("a.small", { href: "#quiz", onclick: () => { $("#quiz-level").value = lv.id; renderQuiz(); } }, lv.id in quizScores() ? `Quiz ${quizScores()[lv.id]}%` : "Quiz")))));
    }
    renderStages(done);
    const n = done.size;
    $("#bar-fill").style.width = (n / Q.levels.length * 100) + "%";
    $("#bar").setAttribute("aria-valuenow", String(n));
    $("#bar-text").textContent = `${n} of ${Q.levels.length} levels complete`;
  }

  function renderStages(done) {
    const stages = [];
    for (const lv of Q.levels) {
      let st = stages.find((x) => x.name === lv.stage);
      if (!st) stages.push(st = { name: lv.stage, levels: [] });
      st.levels.push(lv);
    }
    $("#stages").replaceChildren(...stages.map((st, i) => {
      const n = st.levels.filter((l) => done.has(l.id)).length;
      const ring = h("span.ring", { "aria-hidden": "true" });
      ring.style.setProperty("--p", Math.round(n / st.levels.length * 100));
      return h("a.stage-card" + (n === st.levels.length ? ".complete" : ""), {
        role: "listitem", href: "#" + stageId(st.name), onclick: (e) => { e.preventDefault(); scrollToEl(document.getElementById(stageId(st.name))); }
      }, ring, h("span.stage-num", null, `Stage ${i + 1}`), h("strong", null, st.name), h("span.muted", null, `${n} of ${st.levels.length} levels`));
    }));
  }

  // --- apply flow ----------------------------------------------------------------

  let flowTimer = null;
  function selectFlow(i) {
    document.querySelectorAll("#flow .step").forEach((el, j) => {
      el.classList.toggle("on", j === i);
      el.classList.toggle("past", j < i);
      el.querySelector("button").setAttribute("aria-pressed", String(j === i));
    });
    const step = Q.flow[i];
    $("#flow-detail").replaceChildren(h("p.tag", null, `Step ${i + 1} of ${Q.flow.length} · ${step.role}`), h("h3", null, step.name), h("p", null, ...rich(step.text)), h("pre", null, h("code", null, step.try)));
  }
  function stopFlow() { clearInterval(flowTimer); flowTimer = null; $("#flow-play").textContent = "Play the flow"; }
  function playFlow() {
    if (flowTimer) { stopFlow(); return; }
    let i = 0;
    selectFlow(i);
    $("#flow-play").textContent = "Pause";
    flowTimer = setInterval(() => { i++; if (i >= Q.flow.length) { stopFlow(); return; } selectFlow(i); }, 2600);
  }
  function renderFlow() {
    $("#flow").replaceChildren(...Q.flow.map((step, i) => h("li.step", null,
      h("button", { type: "button", "aria-pressed": "false", onclick: () => { stopFlow(); selectFlow(i); } },
        h("span.dot", { "aria-hidden": "true" }, String(i + 1)), h("span.step-name", null, step.name), h("span.step-role", null, step.role)))));
    $("#flow-play").addEventListener("click", playFlow);
    selectFlow(0);
  }

  // --- quiz ----------------------------------------------------------------

  const EXAM_SIZE = 20;
  const questionsFor = (id) => [...(Q.quiz[id] || []), ...((window.TRACK_QUIZ_BANK || {})[id] || [])].map((item) => ({ ...item, level: id }));
  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const quizScores = () => store.get("quiz", {});

  function renderQuiz() {
    if (!window.TRACK_QUIZ_BANK) { need("quiz").then(renderQuiz); return; }
    const mode = $("#quiz-level").value;
    const exam = mode === "exam";
    const items = exam ? shuffle(Q.levels.flatMap((l) => questionsFor(l.id))).slice(0, EXAM_SIZE) : questionsFor(mode);
    const out = $("#quiz-list");
    out.replaceChildren();
    let answered = 0;
    let correct = 0;
    const score = h("div.score", { "aria-live": "polite" });
    const bar = h("span.fill");
    const updateScore = () => {
      score.replaceChildren(
        h("span", null, h("strong", null, `${correct}`), ` correct of ${answered} answered · ${items.length} questions`),
        h("span.meter", { role: "progressbar", "aria-label": "Answered", "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(answered) }, bar));
      bar.style.width = (answered / items.length * 100) + "%";
      if (answered === items.length) {
        const pct = Math.round(correct / items.length * 100);
        if (!exam) { const all = quizScores(); all[mode] = Math.max(all[mode] || 0, pct); store.set("quiz", all); window.TQEngage.active(); renderPath(); }
        score.append(h("p.result", null, h("strong", null, `${pct}%. `),
          pct === 100 ? "Perfect score." : pct >= 75 ? "Strong. Review the explanations you missed." : "Read the explanations, practise the level's scenarios, and try again.",
          " ", h("button.linkish", { type: "button", onclick: renderQuiz }, exam ? "New exam" : "Try again")));
      }
    };
    items.forEach((item, qi) => {
      const fb = h("p.feedback", { "aria-live": "polite" });
      const opts = h("div.options", { role: "group", "aria-label": `Question ${qi + 1}` });
      shuffle(item.options.map((text, index) => ({ text, index }))).forEach((opt) => {
        opts.append(h("button.opt", {
          type: "button", "data-right": opt.index === item.answer ? "1" : null,
          onclick: (e) => {
            const right = opt.index === item.answer;
            opts.querySelectorAll("button").forEach((b) => { b.disabled = true; if (b.dataset.right) b.classList.add("right"); });
            if (!right) e.currentTarget.classList.add("wrong");
            fb.replaceChildren(h("strong", null, right ? "Correct. " : "Not quite. "), ...rich(item.why));
            fb.className = "feedback " + (right ? "ok" : "bad");
            answered++;
            if (right) correct++;
            updateScore();
          }
        }, ...rich(opt.text)));
      });
      const from = exam ? Q.levels.find((l) => l.id === item.level) : null;
      out.append(h("div.card.question", null, from ? h("p.tag", null, `Level ${from.id} · ${from.topic}`) : null, h("h3", null, `${qi + 1}. `, ...rich(item.q)), opts, fb));
    });
    out.prepend(score);
    updateScore();
  }

  // --- HCL X-ray ------------------------------------------------------------

  const narrow = () => matchMedia("(max-width: 860px)").matches;
  function placeNote(li) {
    const note = $("#xray-note");
    if (li && narrow()) {
      let slot = $("#xray-lines .note-slot");
      if (!slot) slot = h("li.note-slot");
      li.after(slot);
      slot.append(note);
    } else if (note.parentElement !== $("#xray-view")) {
      $("#xray-view").append(note);
      const slot = $("#xray-lines .note-slot");
      if (slot) slot.remove();
    }
  }

  let xrayRes = null;
  let xrayIndex = 0;
  function renderXrayResult(res, name) {
    xrayRes = res;
    const rows = res.lines;
    const lines = $("#xray-lines");
    placeNote(null);
    lines.replaceChildren();
    rows.forEach(({ line, note, level, warns }, i) => {
      if (!note) { lines.append(h("li", null, h("span.line.blank", null, line || " "))); return; }
      const flag = warns.length ? "warn" : level === "unknown" ? "unknown" : "";
      lines.append(h("li", null, h("button.line" + (flag ? "." + flag : ""), {
        type: "button",
        onclick: (e) => {
          lines.querySelectorAll(".line").forEach((b) => b.classList.remove("on"));
          e.currentTarget.classList.add("on");
          placeNote(e.currentTarget.parentElement);
          $("#xray-note").replaceChildren(h("pre", null, h("code", null, line.trim())), h("p", null, ...rich(note)),
            ...warns.map((w) => h("p.xray-warn", null, w)), h("p.muted", null, `Line ${i + 1} of ${rows.length}`));
        }
      }, line)));
    });
    $("#xray-note").replaceChildren(h("p.muted", null, "Select any line to see what it does."));
    const warned = rows.filter((r) => r.warns.length).length;
    const unknown = rows.filter((r) => r.level === "unknown").length;
    const summary = [`${name}: ${rows.filter((r) => r.note).length} lines explained`];
    if (warned) summary.push(`${warned} worth a second look`);
    if (unknown) summary.push(`${unknown} not in the dictionary`);
    $("#xray-summary").textContent = summary.join(" · ");
    $("#xray-review").replaceChildren(...(res.review.length
      ? [h("details.xray-missing", null, h("summary", null, `${res.review.length} missing setting${res.review.length === 1 ? "" : "s"} worth a look`), h("ul.xray-review", null, res.review.map((n) => h("li", null, n))))]
      : []));
    $("#xray-result").hidden = false;
    $("#xray-view").hidden = false;
    const first = $("#xray-lines .line.warn") || $("#xray-lines button.line");
    if (first && !narrow()) first.click();
  }

  function renderXray(index) {
    xrayIndex = index;
    document.querySelectorAll("#xray-pick button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.index) === index)));
    const paste = index === Q.xray.length;
    $("#xray-edit").hidden = !paste || Boolean(xrayRes && xrayRes.pasted);
    $("#xray-actions").hidden = !paste;
    if (paste) {
      if (xrayRes && xrayRes.pasted) renderXrayResult(xrayRes, "Your file");
      else { $("#xray-result").hidden = true; $("#xray-view").hidden = true; }
      return;
    }
    if (!window.TQXray) { need("xray").then(() => { if (xrayIndex === index) renderXray(index); }); return; }
    const res = window.TQXray.explain(Q.xray[index].text);
    renderXrayResult(res, Q.xray[index].path);
  }
  function explainPasted() {
    const text = $("#xray-input").value;
    const error = $("#xray-error");
    const fail = (msg) => { error.textContent = msg; error.hidden = false; };
    if (!text.trim()) return fail("Paste a .tf file first, or choose Load an example.");
    if (!window.TQXray) { need("xray").then(explainPasted); return; }
    const res = window.TQXray.explain(text);
    if (res.error) return fail(res.error);
    error.hidden = true;
    res.pasted = true;
    $("#xray-edit").hidden = true;
    renderXrayResult(res, "Your file");
    scrollToEl($("#xray-result"));
  }
  function editPasted() {
    xrayRes = null;
    renderXray(Q.xray.length);
    $("#xray-input").focus();
  }

  // --- troubleshooting reference ---------------------------------------------

  const STOP = new Set(["error", "the", "and", "for", "this", "that", "with", "was", "are", "not", "has", "have", "from", "you", "your", "can", "will", "run", "terraform", "into", "been", "which", "when", "there", "here", "any"]);
  const words = (text) => String(text).toLowerCase().split(/[^a-z0-9_.-]+/).filter((x) => x.length > 2 && !STOP.has(x));
  const haystack = (d) => [d.title, d.error, d.meaning, ...d.causes, ...d.confirm, ...d.fix].join(" ").toLowerCase();

  // Rank entries for pasted error text or a few search words.
  function searchProblems(text) {
    const q = String(text).trim();
    if (!q) return [];
    const first = q.split("\n").map((l) => l.replace(/^[│╷╵\s]+/, "").replace(/^Error:\s*/, "").trim()).find(Boolean) || "";
    const ws = [...new Set(words(q))];
    return Q.problems.map((d, i) => {
      const hay = haystack(d);
      let score = ws.filter((w) => hay.includes(w)).length / Math.max(1, ws.length);
      if (first.length > 6 && (d.error.toLowerCase().includes(first.toLowerCase().slice(0, 60)) || d.title.toLowerCase().includes(first.toLowerCase()))) score += 2;
      return { i, score };
    }).filter((x) => x.score >= (ws.length > 3 ? 0.5 : 0.99)).sort((a, b) => b.score - a.score).slice(0, 6);
  }

  function buildDoctorList() {
    const index = new Map(Q.problems.map((d, i) => [d.id, i]));
    $("#doctor-list").replaceChildren(...Q.problemGroups.map(([name, ids]) => h("div.doctor-group", null,
      h("div.doctor-group-name", null, name, h("span.doctor-group-count", null, String(ids.length))),
      h("div.doctor-group-items", null, ids.map((id) => h("button.chip", {
        type: "button", "data-index": index.get(id), "aria-pressed": "false", onclick: () => { location.hash = "fix/" + id; }
      }, Q.problems[index.get(id)].title))))));
  }
  function renderDoctorSearch() {
    const hits = searchProblems($("#doctor-q").value);
    const box = $("#doctor-hits");
    if (!$("#doctor-q").value.trim()) { box.replaceChildren(); return; }
    box.replaceChildren(hits.length
      ? h("div.doctor-practise", null, h("span.muted.small", null, "Best matches:"), hits.map(({ i }) => h("button.chip", { type: "button", onclick: () => { location.hash = "fix/" + Q.problems[i].id; } }, Q.problems[i].title)))
      : h("p.muted", null, "No match. Paste the first line of the error (Error: ...), or try a word such as lock, replacement or credentials."));
    if (hits.length && hits[0].score >= 2) renderProblem(hits[0].i, true);
  }

  function renderProblem(index, quiet) {
    const d = Q.problems[index];
    document.querySelectorAll("#doctor-list button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.index) === index)));
    const lv = Q.levels.find((l) => l.id === d.level);
    const names = titles();
    const copy = h("button.copy-link", { type: "button" }, "Copy link");
    copy.addEventListener("click", () => copyLink("fix/" + d.id, copy));
    const list = (tag, items) => h(tag, null, items.map((t) => h("li", null, ...rich(t))));
    $("#doctor-out").replaceChildren(h("article.card.problem", { id: "problem-" + d.id },
      h("div.problem-head", null, h("h3", null, d.title), copy),
      h("pre.err", null, h("code", null, d.error)),
      h("h4", null, "Why it happens"), h("p", null, ...rich(d.meaning)),
      h("h4", null, "Likely causes"), list("ul", d.causes),
      h("h4", null, "Confirm"), h("pre", null, h("code", null, d.confirm.join("\n"))),
      h("h4", null, "Fix"), list("ol", d.fix),
      h("h4", null, "Prevent it"), list("ul", d.prevent),
      // Fixing is the way in; the point is to learn it, so every answer ends in practice.
      h("div.learn-it", null,
        h("h4", null, "Now learn it"),
        h("p", null, "Break this yourself in a safe playground and fix it. Doing it once is what makes you recognise it next time."),
        h("div.doctor-practise", null, h("span.muted.small", null, "Practise:"),
          d.practise.filter((id) => names[id]).map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, names[id]))),
        lv ? h("p.note", null, "Then the level that teaches it: ", h("a", { href: "#path", onclick: (e) => { e.preventDefault(); goTab("path", () => scrollToEl($("#" + stageId(lv.stage)))); } }, `Level ${lv.id} · ${lv.title}`)) : null)));
    if (!quiet) scrollToEl($("#doctor-out"));
  }

  // --- cheat sheet ---------------------------------------------------------

  function copyButton(text) {
    return h("button.copy", {
      type: "button", "aria-label": "Copy command",
      onclick: async (e) => {
        const b = e.currentTarget;
        try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select it"; }
        setTimeout(() => { b.textContent = "Copy"; }, 1200);
      }
    }, "Copy");
  }
  const FILL = [
    { key: "addr", label: "Resource address", example: "aws_s3_bucket.site" },
    { key: "id", label: "Real ID", example: "i-0abc123def4567890" },
    { key: "ws", label: "Workspace", example: "staging" },
    { key: "plan", label: "Plan file", example: "tfplan" },
    { key: "lock-id", label: "Lock ID", example: "b7d1e9a2-..." },
    { key: "version", label: "Terraform version", example: "1.10.5" }
  ];
  const fills = store.get("fill", {});
  function fillParts(cmd) {
    return cmd.split(/(<[a-z-]+>)/).filter(Boolean).map((part) => {
      const m = /^<([a-z-]+)>$/.exec(part);
      if (!m) return { text: part };
      const value = fills[m[1]];
      return value ? { text: value, filled: true } : { text: part, hole: true };
    });
  }
  function renderFill() {
    $("#cheat-fill").replaceChildren(...FILL.map((f) => h("label.fill", null, f.label,
      h("input", {
        type: "text", value: fills[f.key] || "", placeholder: f.example, spellcheck: "false", autocapitalize: "off",
        oninput: (e) => {
          const v = e.target.value.trim().replace(/[^\w.:/@[\]"-]/g, "");
          if (v) fills[f.key] = v; else delete fills[f.key];
          store.set("fill", fills);
          renderCheats();
        }
      }))));
  }
  function renderCheats() {
    const q = $("#cheat-q").value.trim().toLowerCase();
    const out = $("#cheat-out");
    out.replaceChildren();
    const groups = new Map();
    for (const [cmd, what, group, where] of Q.cheats) {
      if (q && !(cmd + " " + what + " " + group).toLowerCase().includes(q)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([cmd, what, where]);
    }
    if (!groups.size) { out.append(h("p.muted", null, "No match. Try a word such as state, plan or lock.")); return; }
    const names = titles();
    for (const [group, rows] of groups) {
      out.append(h("h3.group", null, group), h("ul.cheats", null, rows.map(([cmd, what, where]) => {
        const parts = fillParts(cmd);
        const full = parts.map((p) => p.text).join("");
        const code = h("code", null, parts.map((p) => (p.filled ? h("span.filled", null, p.text) : p.hole ? h("span.hole", null, p.text) : p.text)));
        const actions = h("div.cheat-actions", null,
          where && names[where] ? h("button.copy", {
            type: "button", title: `Run it in the playground scenario "${names[where]}"`,
            onclick: () => { location.hash = "play/" + where; show(); withPg((p) => p.prefill(full, where)); }
          }, "Try") : h("a.copy.lab", { href: Q.repo + "#readme", title: "Needs Terraform and an account of your own" }, "Lab"),
          copyButton(full));
        return h("li", null, h("div", null, code, h("span.muted", null, what)), actions);
      })));
    }
  }

  // --- page guides -------------------------------------------------------------

  const GUIDES_CLOSED_BY_DEFAULT = ["playground", "path", "doctor", "xray"];
  function renderGuides() {
    const state = store.get("guides", {});
    document.querySelectorAll(".guide-slot").forEach((slot) => {
      const key = slot.dataset.guide;
      const g = Q.guides[key];
      if (!g) return;
      const box = h("details.guide", { open: state[key] ?? !GUIDES_CLOSED_BY_DEFAULT.includes(key) },
        h("summary", null, "How to use this"),
        h("div.guide-body", null,
          h("p", null, ...rich(g.what)),
          h("div.guide-cols", null,
            h("div", null, h("h3", null, "How to use it"), h("ol", null, g.steps.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h3", null, "What it is for"), h("ul", null, g.uses.map((t) => h("li", null, ...rich(t)))),
              h("h3", null, "Tips"), h("ul", null, g.tips.map((t) => h("li", null, ...rich(t))))))));
      let shown = box.open;
      box.addEventListener("toggle", () => {
        if (box.open === shown) return;
        shown = box.open;
        store.set("guides", { ...store.get("guides", {}), [key]: shown });
      });
      slot.replaceChildren(box);
    });
  }

  // --- command palette (Ctrl+K, Cmd+K or /) --------------------------------

  const palette = $("#palette");
  const paletteInput = $("#palette-input");
  const paletteList = $("#palette-list");
  let paletteItems = [];
  let paletteActive = 0;
  function goTab(tab, then) { location.hash = tab; show(); if (then) then(); }
  const ACTIONS = [
    { label: "Playground: fix a broken project", kind: "Section", run: () => goTab("path", () => { $(".playground").scrollIntoView(); $("#pg-input").focus(); }) },
    { label: "What happens on terraform apply", kind: "Section", run: () => goTab("path", () => $(".flow-block").scrollIntoView()) },
    { label: "Your path", kind: "Section", run: () => goTab("path", () => $("#path-title").scrollIntoView()) },
    { label: "Exam: random questions from every level", kind: "Quiz", run: () => goTab("quiz", () => { $("#quiz-level").value = "exam"; renderQuiz(); }) },
    { label: "HCL X-ray", kind: "Section", run: () => goTab("xray") },
    { label: "Fix: troubleshoot an error", kind: "Section", run: () => goTab("doctor", () => $("#doctor-q").focus()) },
    { label: "Cheat sheet", kind: "Section", run: () => goTab("cheats", () => $("#cheat-q").focus()) },
    { label: "How apply works", kind: "Section", run: () => goTab("arch") },
    ...Q.levels.map((lv) => ({ label: `Quiz: ${lv.id} · ${lv.topic}`, kind: "Quiz", run: () => goTab("quiz", () => { $("#quiz-level").value = lv.id; renderQuiz(); }) })),
    ...Q.problems.map((d) => ({ label: `Error: ${d.title}`, hint: d.error, kind: "Reference", run: () => { location.hash = "fix/" + d.id; } }))
  ];
  function renderPalette() {
    const ws = paletteInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const scenarios = SCENARIOS.map((sc) => ({ label: `Playground: ${sc.title}`, hint: sc.group, kind: "Practice", run: () => practise(sc.id) }));
    paletteItems = [...ACTIONS, ...scenarios].filter((a) => {
      const text = `${a.label} ${a.hint || ""} ${a.kind}`.toLowerCase();
      return ws.every((w) => text.includes(w));
    }).slice(0, 8);
    paletteActive = Math.min(paletteActive, Math.max(0, paletteItems.length - 1));
    paletteList.replaceChildren(...paletteItems.map((a, i) => h("li", {
      role: "option", id: "pal-" + i, "aria-selected": String(i === paletteActive),
      onclick: () => choose(i), onmousemove: () => { if (paletteActive !== i) { paletteActive = i; renderPalette(); } }
    }, h("span.pal-label", null, a.label), h("span.pal-kind", null, a.kind))));
    if (!paletteItems.length) paletteList.append(h("li.pal-empty", null, "Nothing matches. Try a topic such as state, lock or module."));
    paletteInput.setAttribute("aria-activedescendant", paletteItems.length ? "pal-" + paletteActive : "");
  }
  function openPalette() {
    if (palette.open) return;
    warm();
    paletteInput.value = "";
    paletteActive = 0;
    renderPalette();
    palette.showModal();
    paletteInput.focus();
  }
  function choose(i) { const a = paletteItems[i]; if (!a) return; palette.close(); a.run(); }
  paletteInput.addEventListener("input", () => { paletteActive = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = paletteItems.length;
      if (n) paletteActive = (paletteActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPalette();
      const active = document.getElementById("pal-" + paletteActive);
      if (active) active.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); choose(paletteActive); }
  });
  palette.addEventListener("click", (e) => { if (e.target === palette) palette.close(); });
  $("#palette-open").addEventListener("click", openPalette);
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $("#palette-key").textContent = "⌘K";
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); } else if (e.key === "/" && !typing) { e.preventDefault(); openPalette(); }
  });

  // --- init ----------------------------------------------------------------

  $("#quiz-level").append(h("option", { value: "exam" }, `Exam: ${EXAM_SIZE} random questions from every level`));
  const quizLabel = (lv) => `${lv.id} · ${lv.topic} (${questionsFor(lv.id).length} questions)`;
  for (const lv of Q.levels) $("#quiz-level").append(h("option", { value: lv.id }, quizLabel(lv)));
  // The counts include the question bank once it has loaded.
  ready.quiz = () => { for (const lv of Q.levels) $(`#quiz-level option[value="${lv.id}"]`).textContent = quizLabel(lv); renderQuiz(); };
  $("#quiz-level").value = "00";
  $("#quiz-level").addEventListener("change", renderQuiz);
  $("#quiz-again").addEventListener("click", () => { renderQuiz(); $("#quiz-list").scrollIntoView({ block: "start" }); });
  $("#xray-pick").append(h("button", { type: "button", role: "tab", "data-index": Q.xray.length, onclick: () => { renderXray(Q.xray.length); if (!(xrayRes && xrayRes.pasted)) $("#xray-input").focus(); } }, "Paste your .tf"));
  Q.xray.forEach((m, i) => $("#xray-pick").append(h("button", { type: "button", role: "tab", "data-index": i, onclick: () => { xrayRes = null; renderXray(i); } }, m.name)));
  $("#xray-go").addEventListener("click", explainPasted);
  $("#xray-edit-btn").addEventListener("click", editPasted);
  $("#xray-clear").addEventListener("click", () => { $("#xray-input").value = ""; $("#xray-error").hidden = true; editPasted(); });
  $("#xray-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) explainPasted(); });
  $("#xray-example").addEventListener("click", () => { $("#xray-input").value = Q.xrayExample; explainPasted(); });
  buildDoctorList();
  $("#doctor-q").addEventListener("input", renderDoctorSearch);
  // The home page's "Something broken?" box hands the pasted error to Troubleshoot.
  const doorGo = () => { $("#doctor-q").value = $("#door-q").value; goTab("doctor", () => { renderDoctorSearch(); $("#doctor-q").focus(); }); };
  $("#door-go").addEventListener("click", doorGo);
  $("#door-q").addEventListener("keydown", (e) => { if (e.key === "Enter") doorGo(); });
  $("#forget").addEventListener("click", forgetEverything);
  $("#cheat-q").addEventListener("input", renderCheats);
  renderFill();
  $("#cheat-fill-box").open = matchMedia("(min-width: 721px)").matches || Object.keys(fills).length > 0;

  // Shared with engage.js and architecture.js, which load after this script.
  window.TQUI = { h, rich, practise, need };

  renderGuides();
  renderFlow();
  renderXray(Q.xray.length);
  renderCheats();
  $("#pg-copy").addEventListener("click", (e) => { const btn = e.currentTarget; withPg((p) => copyLink("play/" + p.current(), btn)); });
  show();
  // The first screen in one pass, once engage.js has run too, then the heavy
  // features in the background.
  window.addEventListener("DOMContentLoaded", () => {
    renderSignature();
    renderLanding();
    renderPath();
    window.TQEngage.render();
    show();
    if (/^#play\//.test(location.hash)) need("play").then(() => $(".playground").scrollIntoView({ block: "start" }));
    if (/^#fix\//.test(location.hash)) $("#doctor-out").scrollIntoView({ block: "start" });
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => warm());
  });
})();
