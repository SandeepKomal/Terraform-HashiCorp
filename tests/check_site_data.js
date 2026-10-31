// Checks the site's data: levels, quiz questions, problems, guides and the
// architecture are complete and well formed, and the pages keep their rules.
// Run with: node tests/check_site_data.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
global.window = {};
require(path.join(root, "site/data.js"));
require(path.join(root, "site/quiz-bank.js"));
const Q = window.TRACK;
const bank = window.TRACK_QUIZ_BANK;

assert.deepStrictEqual(Q.levels.map((l) => l.id), Q.levels.map((_, i) => String(i).padStart(2, "0")), "levels are numbered in order");
for (const lv of Q.levels) {
  for (const k of ["title", "topic", "stage", "learn"]) assert.ok(lv[k], `level ${lv.id}: ${k}`);
  assert.ok(lv.lab.length > 0, `level ${lv.id}: a lab`);
  if (lv.example) assert.ok(fs.existsSync(path.join(root, lv.example)), `level ${lv.id}: example ${lv.example} exists in the repository`);
}

let total = 0;
for (const lv of Q.levels) {
  const items = [...(Q.quiz[lv.id] || []), ...(bank[lv.id] || [])];
  assert.ok(items.length >= 8, `level ${lv.id} needs at least 8 quiz questions, has ${items.length}`);
  const seen = new Set();
  for (const item of items) {
    total++;
    const where = `level ${lv.id}: "${item.q}"`;
    assert.ok(item.q.length > 10 && !seen.has(item.q), `${where}: question text`);
    seen.add(item.q);
    assert.strictEqual(item.options.length, 4, `${where}: 4 options`);
    assert.strictEqual(new Set(item.options).size, 4, `${where}: options differ`);
    assert.ok(Number.isInteger(item.answer) && item.answer >= 0 && item.answer < 4, `${where}: answer index`);
    assert.ok(item.why.length > 20, `${where}: explanation`);
    for (const t of [item.q, item.why, ...item.options]) assert.strictEqual((t.match(/`/g) || []).length % 2, 0, `${where}: backticks in "${t}"`);
  }
}

const pids = new Set();
for (const d of Q.problems) {
  assert.ok(/^[a-z0-9-]+$/.test(d.id) && !pids.has(d.id), `problem id ${d.id}`);
  pids.add(d.id);
  for (const k of ["title", "error", "meaning"]) assert.ok(d[k], `${d.id}: ${k}`);
  for (const k of ["causes", "confirm", "fix", "prevent", "practise"]) assert.ok(Array.isArray(d[k]) && d[k].length, `${d.id}: ${k}`);
  assert.ok(Q.levels.some((l) => l.id === d.level), `${d.id}: level`);
}
const grouped = Q.problemGroups.flatMap(([, ids]) => ids);
assert.deepStrictEqual([...grouped].sort(), [...pids].sort(), "every problem belongs to exactly one group");
assert.ok(Q.problems.length >= 40, "the reference covers the common errors");

for (const step of Q.flow) assert.ok(step.name && step.text && step.try);
for (const c of Q.architecture.components) for (const k of ["id", "name", "short", "where", "role", "breaks"]) assert.ok(c[k], `architecture ${c.id}: ${k}`);
for (const [key, g] of Object.entries(Q.guides)) assert.ok(g.what && g.steps.length && g.uses.length && g.tips.length, `guide ${key}`);

// Page rules: the same CSP everywhere, no inline styles or handlers, nothing from other sites.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
for (const f of ["index.html", "problems.html"]) {
  const html = fs.readFileSync(path.join(root, "site", f), "utf8");
  assert.ok(html.includes(`content="${CSP}"`), `${f}: CSP`);
  assert.ok(!/\sstyle="|\son[a-z]+="/i.test(html), `${f}: no inline styles or handlers`);
  assert.ok(!/(src|href)="https?:\/\/(?!github\.com|sandeepkomal\.github\.io)/.test(html), `${f}: nothing loaded from other sites`);
  assert.ok(html.includes("Terraform® and HashiCorp® are trademarks of HashiCorp, Inc. This project is independent and not affiliated with HashiCorp."), `${f}: trademark line`);
}
for (const f of fs.readdirSync(path.join(root, "site")).filter((x) => x.endsWith(".js"))) {
  const js = fs.readFileSync(path.join(root, "site", f), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), `${f}: no HTML injection or eval`);
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(js), `${f}: no network requests`);
}

console.log(`site data ok: ${Q.levels.length} levels, ${total} quiz questions, ${Q.problems.length} problems, ${Q.cheats.length} cheat sheet commands`);
