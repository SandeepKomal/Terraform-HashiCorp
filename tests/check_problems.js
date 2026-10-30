// site/problems.html must be exactly what tools/build-problems.js generates,
// so the plain reference never drifts from the interactive one.
// Run with: node tests/check_problems.js   (fix with: node tools/build-problems.js)
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const { render } = require(path.join(root, "tools/build-problems.js"));
const html = fs.readFileSync(path.join(root, "site/problems.html"), "utf8");
assert.strictEqual(html, render(), "site/problems.html is out of date: run node tools/build-problems.js");
assert.ok(!/<script/i.test(html), "problems.html works without JavaScript");
for (const d of window.QUEST.problems) assert.ok(html.includes(`id="${d.id}"`), `section for ${d.id}`);
const sitemap = fs.readFileSync(path.join(root, "site/sitemap.xml"), "utf8");
assert.ok(sitemap.includes(window.QUEST.site) && sitemap.includes("problems.html"), "sitemap lists the pages");
assert.ok(fs.readFileSync(path.join(root, "site/robots.txt"), "utf8").includes("sitemap.xml"));
console.log(`problems ok: ${window.QUEST.problems.length} entries in problems.html`);
