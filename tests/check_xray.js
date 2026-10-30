// Checks the HCL X-ray: every line of the repository's own examples gets a
// note, risky settings are flagged, missing essentials are listed, and bad
// input gives a clear error instead of an exception.
// Run with: node tests/check_xray.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
require(path.join(root, "site/hcl.js"));
require(path.join(root, "site/xray.js"));
global.window = {};
require(path.join(root, "site/data.js"));
const { explain } = globalThis.TQXray;
const Q = window.QUEST;

// The embedded examples are the repository's files, byte for byte.
for (const x of Q.xray) assert.strictEqual(x.text, fs.readFileSync(path.join(root, x.path), "utf8"), `${x.path} is out of date in site/data.js`);

// Every .tf file in the repository parses and every non-blank line is explained.
const tf = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "site") continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".tf")) tf.push(p); } };
walk(root);
assert.ok(tf.length > 30);
for (const f of tf) {
  const res = explain(fs.readFileSync(f, "utf8"));
  assert.ok(!res.error, `${f}: ${res.error}`);
  for (const r of res.lines) if (r.line.trim()) assert.ok(r.note, `${f}: no note for "${r.line}"`);
}

const ex = explain(Q.xrayExample);
const warned = (re) => ex.lines.some((r) => r.warns.some((w) => re.test(w)));
assert.ok(warned(/Port 22 open to the whole internet/), "0.0.0.0/0 on 22");
assert.ok(warned(/hard-coded password/), "hard-coded secret");
assert.ok(warned(/public endpoint/), "public database");
assert.ok(warned(/Makes the bucket public/), "public ACL");
assert.ok(warned(/No state locking/), "backend without locking");
assert.ok(warned(/not marked sensitive/), "secret variable");
assert.ok(warned(/No version constraint/), "provider without version");
assert.ok(warned(/No final snapshot/), "skip_final_snapshot");
assert.ok(ex.review.some((r) => /required_version/.test(r)), "missing required_version");
assert.ok(ex.review.some((r) => /deletion_protection/.test(r)), "database protection");

const sg = explain(Q.xray[0].text);
assert.ok(sg.review.some((r) => /required_version/.test(r)));

// Bad input: errors, never exceptions.
for (const bad of ["resource \"x\" {", "a = ", "}}}", "x = \"open", "resource \"a\" \"b\" { x = [1, }", "\u0000", "a".repeat(5000), "x\n".repeat(700)]) {
  const r = explain(bad);
  assert.ok(r.error || Array.isArray(r.lines), `handles ${JSON.stringify(bad.slice(0, 20))}`);
}
assert.match(explain("resource \"x\" \"y\" {\n").error, /Line 1: Unclosed configuration block/);
assert.ok(explain("x\n".repeat(700)).error.includes("up to"));

// The key ID is assembled at run time so this file never contains one.
const keyed = explain(`provider "aws" {\n  access_key = "${"AKIA" + "QUESTPRACTICE001"}"\n}\n`);
assert.ok(keyed.lines[1].warns.some((w) => /access key ID/.test(w)) && keyed.lines[1].warns.some((w) => /provider block/.test(w)), "credentials in provider block");

console.log(`xray ok: ${tf.length} repository files explained, example flags ${ex.lines.filter((r) => r.warns.length).length} lines`);
