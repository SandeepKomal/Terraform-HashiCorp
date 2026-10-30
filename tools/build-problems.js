// Builds site/problems.html: the troubleshooting reference as plain HTML that
// reads without JavaScript, one section per problem with its exact error text.
// Run with: node tools/build-problems.js   (tests/check_problems.js keeps it in sync)
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function render() {
  global.window = {};
  require(path.join(root, "site/data.js"));
  require(path.join(root, "site/hcl.js"));
  require(path.join(root, "site/playground.js"));
  const Q = window.QUEST;
  const titles = Object.fromEntries(window.TQSim.SCENARIOS.map((s) => [s.id, s.title]));
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const code = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");
  const byId = Object.fromEntries(Q.problems.map((d) => [d.id, d]));
  const out = [];
  out.push(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="Every common Terraform error with its exact message, what it means, the likely causes, how to confirm, the fix and how to prevent it: ${Q.problems.length} entries.">
  <meta property="og:type" content="article">
  <meta property="og:title" content="Terraform errors and fixes: Terraform Quest">
  <meta property="og:description" content="Exact Terraform error messages with causes, fixes and prevention.">
  <link rel="canonical" href="${Q.site}problems.html">
  <title>Terraform errors and fixes</title>
  <link rel="stylesheet" href="style.css">
  <link rel="icon" href="logo.svg" type="image/svg+xml">
</head>
<body>
  <main class="wrap problems-page">
    <p class="eyebrow"><img src="logo.svg" alt="" width="28" height="28"><a href="./">Terraform Quest</a></p>
    <h1>Terraform errors and fixes</h1>
    <p class="lede">${Q.problems.length} errors and surprises, each with the exact message, what it means, how to confirm the cause, the fix and how to prevent it. The <a href="./#doctor">interactive version</a> also searches pasted error text and opens each fix in a practice scenario.</p>
    <nav aria-label="Problems">`);
  for (const [group, ids] of Q.problemGroups) {
    out.push(`      <h2>${esc(group)}</h2>\n      <ul>`);
    for (const id of ids) out.push(`        <li><a href="#${id}">${esc(byId[id].title)}</a></li>`);
    out.push("      </ul>");
  }
  out.push("    </nav>");
  for (const d of Q.problems) {
    out.push(`    <section class="card problem" id="${d.id}">
      <h2>${esc(d.title)}</h2>
      <pre class="err"><code>${esc(d.error)}</code></pre>
      <p>${code(d.meaning)}</p>
      <h3>Likely causes</h3>
      <ul>${d.causes.map((c) => `<li>${code(c)}</li>`).join("")}</ul>
      <h3>Confirm</h3>
      <pre><code>${esc(d.confirm.join("\n"))}</code></pre>
      <h3>Fix</h3>
      <ol>${d.fix.map((c) => `<li>${code(c)}</li>`).join("")}</ol>
      <h3>Prevent it</h3>
      <ul>${d.prevent.map((c) => `<li>${code(c)}</li>`).join("")}</ul>
      <p>Practise it: ${d.practise.map((id) => `<a href="./#play/${id}">${esc(titles[id])}</a>`).join(", ")} · <a href="./#fix/${d.id}">Open interactive</a></p>
    </section>`);
  }
  out.push(`  </main>
  <footer class="foot">
    <div class="wrap foot-base">
      <p>© 2024–2026 Sandeep Komal Pothu and contributors. Open source under the MIT License. No trackers, no cookies.</p>
      <p class="foot-tm">Terraform® and HashiCorp® are trademarks of HashiCorp, Inc. This project is independent and not affiliated with HashiCorp.</p>
    </div>
  </footer>
</body>
</html>
`);
  return out.join("\n");
}

module.exports = { render };
if (require.main === module) {
  fs.writeFileSync(path.join(root, "site/problems.html"), render());
  console.log("wrote site/problems.html");
}
