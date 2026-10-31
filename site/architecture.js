// The Architecture tab: a diagram of a Terraform run in which every component
// can be pointed at, tapped or reached with Tab to read what it does and how it fails.
"use strict";

(function () {
  const { h, rich, practise } = window.TQUI;
  const parts = Object.fromEntries(window.TRACK.architecture.components.map((c) => [c.id, c]));
  const root = document.getElementById("arch");

  const NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  }

  // Two hand-placed layouts. Boxes are [x, y, width, height].
  const LAYOUTS = {
    wide: {
      size: [1040, 520], font: [13, 11],
      panels: [["Your laptop or CI runner", 20, 20, 250, 480, "node"], ["Terraform", 290, 20, 280, 480, "cp"], ["Remote services", 590, 20, 430, 480, "addon"]],
      boxes: {
        you: [45, 80, 200, 56], config: [45, 210, 200, 56], lockfile: [45, 340, 200, 56],
        core: [320, 140, 220, 70], providers: [320, 330, 220, 60],
        backend: [615, 80, 180, 56], state: [820, 80, 180, 56], registry: [615, 250, 180, 56], cloud: [615, 400, 385, 70]
      },
      edges: [
        ["you", "core", [[245, 108], [282, 108], [282, 160], [320, 160]]],
        ["config", "core", [[245, 238], [282, 238], [282, 190], [320, 190]]],
        ["lockfile", "providers", [[245, 368], [282, 368], [282, 360], [320, 360]]],
        ["core", "providers", [[430, 210], [430, 330]]],
        ["core", "backend", [[540, 160], [580, 160], [580, 108], [615, 108]]],
        ["backend", "state", [[795, 108], [820, 108]]],
        ["registry", "providers", [[615, 278], [580, 278], [580, 345], [540, 345]]],
        ["providers", "cloud", [[540, 375], [580, 375], [580, 435], [615, 435]]]
      ]
    },
    narrow: {
      size: [360, 940], font: [12, 11],
      panels: [["Your laptop or CI runner", 5, 10, 350, 250, "node"], ["Terraform", 5, 290, 350, 230, "cp"], ["Remote services", 5, 550, 350, 380, "addon"]],
      boxes: {
        you: [20, 50, 150, 50], config: [190, 50, 150, 50], lockfile: [105, 180, 150, 50],
        core: [55, 330, 250, 60], providers: [55, 440, 250, 56],
        backend: [20, 590, 150, 50], state: [190, 590, 150, 50], registry: [105, 700, 150, 50], cloud: [55, 830, 250, 60]
      },
      edges: [
        ["you", "core", [[95, 100], [95, 330]]],
        ["config", "core", [[265, 100], [265, 330]]],
        ["lockfile", "providers", [[180, 230], [180, 270], [35, 270], [35, 468], [55, 468]]],
        ["core", "providers", [[180, 390], [180, 440]]],
        ["core", "backend", [[305, 360], [340, 360], [340, 570], [95, 570], [95, 590]]],
        ["backend", "state", [[170, 615], [190, 615]]],
        ["registry", "providers", [[255, 725], [325, 725], [325, 468], [305, 468]]],
        ["providers", "cloud", [[180, 496], [180, 520], [20, 520], [20, 860], [55, 860]]]
      ]
    }
  };
  const idOf = (key) => key.split("@")[0];

  const figure = h("div.arch-figure");
  // One terraform apply, played on the diagram.
  const TOUR = [
    [[["you", "core"], ["config", "core"]], "You run terraform apply. Core reads every .tf file and checks it against the provider schemas."],
    [[["core", "backend"], ["backend", "state"]], "The backend takes the state lock and loads the last known state."],
    [[["lockfile", "providers"], ["core", "providers"]], "Core starts the provider versions the lock file names, as separate plugin processes."],
    [[["providers", "cloud"]], "Providers refresh: they read each real object, so drift shows up."],
    [[["core", "providers"]], "Core builds the graph and the plan. You read it and type yes."],
    [[["providers", "cloud"]], "Providers make the API calls in dependency order."],
    [[["core", "backend"], ["backend", "state"]], "Each result is written to state, outputs are saved, and the lock is released."]
  ];

  const tip = h("div.arch-tip", { "aria-hidden": "true" });
  const detail = h("div.arch-detail", { hidden: true, "aria-live": "polite" });
  const play = h("button.pill.small-pill", { type: "button", onclick: () => (touring ? stopTour() : tour()) }, "Follow a terraform apply");
  const caption = h("p.arch-caption", { "aria-live": "polite" }, "Point at any component to see what it does and what it talks to.");
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let svg = null, dot = null, pinned = null, touring = 0, entered = false;

  function draw() {
    const L = LAYOUTS[matchMedia("(max-width: 720px)").matches ? "narrow" : "wide"];
    const [w, ht] = L.size;
    const arrow = (id) => s("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      s("path", { d: "M0 0 8 4 0 8z" }));
    svg = s("svg", { viewBox: `0 0 ${w} ${ht}`, class: "arch-svg", role: "group", "aria-label": "How apply works" },
      s("defs", null, arrow("arch-arrow"), arrow("arch-arrow-on")));
    for (const [label, x, y, pw, ph, kind] of L.panels) {
      svg.append(s("rect", { x, y, width: pw, height: ph, rx: 16, class: `arch-panel arch-${kind}` }),
        s("text", { x: x + 14, y: y + 22, class: "arch-panel-label" }, label));
    }
    for (const [from, to, pts] of L.edges) {
      svg.append(s("polyline", { points: pts.join(" "), class: "arch-edge", "data-from": from, "data-to": to, "marker-end": "url(#arch-arrow)" }));
    }
    Object.entries(L.boxes).forEach(([key, [x, y, bw, bh]], i) => {
      const c = parts[idOf(key)];
      const g = s("g", { class: `arch-box arch-${c.where === "Terraform" ? "cp" : c.where === "Your code" || c.where === "Where it runs" ? "node" : "addon"}`, "data-id": c.id, "data-key": key },
        s("rect", { x, y, width: bw, height: bh, rx: 10 }),
        s("text", { x: x + bw / 2, y: y + bh / 2 - (bh > 44 ? 3 : 1), class: "arch-name", "font-size": L.font[0] }, c.name),
        s("text", { x: x + bw / 2, y: y + bh / 2 + L.font[1] + 2, class: "arch-short", "font-size": L.font[1] }, c.short));
      g.style.animationDelay = `${120 + i * 28}ms`;
      // One stop per component for the keyboard, on its first box.
      if (!svg.querySelector(`[data-id="${c.id}"]`)) {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.setAttribute("aria-label", `${c.name}: ${c.short}`);
      }
      g.addEventListener("mouseenter", () => touring || select(c.id));
      g.addEventListener("focus", () => touring || select(c.id));
      g.addEventListener("click", () => { stopTour(); pinned = c.id; select(c.id); open(c.id); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      svg.append(g);
    });
    dot = s("circle", { r: 6, class: "arch-dot" });
    svg.append(dot);
    svg.addEventListener("mouseleave", () => touring || select(pinned));
    figure.replaceChildren(svg, tip, h("div.arch-tour", null, play, caption));
    stopTour();
    select(pinned);
  }

  // Light up some components and edges; with one id, its neighbours too.
  function light(ids, edges) {
    svg.classList.toggle("has-focus", ids.length > 0);
    const near = new Set(ids);
    svg.querySelectorAll(".arch-edge").forEach((e) => {
      const ends = [idOf(e.dataset.from), idOf(e.dataset.to)];
      const on = edges ? edges.includes(e) : ends.some((x) => ids.includes(x));
      if (on) ends.forEach((x) => near.add(x));
      e.classList.toggle("is-on", on);
      e.setAttribute("marker-end", `url(#arch-arrow${on ? "-on" : ""})`);
    });
    svg.querySelectorAll(".arch-box").forEach((g) => {
      g.classList.toggle("is-on", ids.includes(g.dataset.id));
      g.classList.toggle("is-near", !ids.includes(g.dataset.id) && near.has(g.dataset.id));
    });
  }

  function select(id) {
    light(id ? [id] : []);
    place(id);
  }

  const body = (c) => [
    h("p.arch-where", null, c.where),
    h("h3", null, c.name),
    h("p", null, c.role),
    h("h4", null, "What it does"),
    h("ul", null, c.does.map((d) => h("li", null, rich(d)))),
    h("h4", null, "When it breaks"),
    h("p", null, rich(c.breaks)),
    h("h4", null, "Look at it"),
    h("pre", null, h("code", null, c.look.join("\n"))),
    practiseRow(c)
  ];
  function practiseRow(c) {
    const titles = Object.fromEntries((window.TQPlayground ? window.TQPlayground.scenarios : []).map((x) => [x.id, x.title]));
    const ids = c.practise.filter((id) => titles[id]);
    return ids.length ? h("div.doctor-practise", null, h("span.muted.small", null, "Practise in the playground:"),
      ids.map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, titles[id]))) : null;
  }

  // A click opens everything about a component below the diagram.
  function open(id) {
    detail.replaceChildren(h("div.card", null, ...body(parts[id])));
    detail.hidden = false;
    detail.scrollIntoView({ block: "nearest", behavior: still() ? "auto" : "smooth" });
  }

  // On hover, a short tip beside the component; touch screens go straight to the click.
  function place(id) {
    const show = id && figure.offsetParent && !matchMedia("(max-width: 720px), (hover: none)").matches;
    tip.classList.toggle("is-shown", Boolean(show));
    if (!show) return;
    const c = parts[id];
    tip.replaceChildren(h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role),
      h("p", null, h("strong", null, "When it breaks: "), rich(c.breaks)),
      h("p.muted.small", null, "Click for commands and practice"));
    const box = svg.querySelector(`[data-id="${id}"] rect`).getBoundingClientRect();
    const frame = figure.getBoundingClientRect();
    const right = box.right - frame.left + 12;
    const left = right + tip.offsetWidth <= frame.width ? right : Math.max(0, box.left - frame.left - tip.offsetWidth - 12);
    const top = Math.min(Math.max(0, box.top - frame.top - 8), Math.max(0, frame.height - tip.offsetHeight - 60));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  // Move the dot along an edge, in either direction.
  function travel(from, to, run) {
    const e = [...svg.querySelectorAll(".arch-edge")].find((x) =>
      (x.dataset.from === from && x.dataset.to === to) || (x.dataset.from === to && x.dataset.to === from));
    let pts = e.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
    if (e.dataset.from !== from) pts = pts.reverse();
    const segs = pts.slice(1).map((p, i) => [pts[i], p, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])]);
    const total = segs.reduce((n, sg) => n + sg[2], 0);
    const at = (d) => {
      for (const [a, b, len] of segs) { if (d <= len) return [a[0] + (b[0] - a[0]) * d / len, a[1] + (b[1] - a[1]) * d / len]; d -= len; }
      return pts[pts.length - 1];
    };
    dot.classList.add("is-on");
    return { edge: e, done: new Promise((resolve) => {
      if (still()) { [dot.cx.baseVal.value, dot.cy.baseVal.value] = pts[pts.length - 1]; return resolve(); }
      const ms = Math.max(450, total * 2.2), start = performance.now();
      const frame = (now) => {
        if (run !== touring) return resolve();
        const t = Math.min(1, (now - start) / ms), ease = t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
        [dot.cx.baseVal.value, dot.cy.baseVal.value] = at(total * ease);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    }) };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function tour() {
    const run = ++touring;
    pinned = null;
    place(null);
    play.textContent = "Stop";
    for (const [n, [hops, text]] of TOUR.entries()) {
      caption.replaceChildren(h("span.arch-step", null, `${n + 1} of ${TOUR.length}`), text);
      const edges = [];
      for (const [from, to] of hops) {
        const leg = travel(from, to, run);
        edges.push(leg.edge);
        light([...new Set(hops.flat().map(idOf))], edges);
        await leg.done;
        if (run !== touring) return;
      }
      await wait(still() ? 3200 : 1500);
      if (run !== touring) return;
    }
    stopTour("Played. Point at any component to read more, or play it again.");
  }
  function stopTour(text) {
    touring = 0;
    if (dot) dot.classList.remove("is-on");
    play.textContent = "Follow a terraform apply";
    if (text) caption.textContent = text;
    if (svg) light([]);
  }

  // The diagram assembles itself the first time the tab opens.
  function enter() {
    if (entered || location.hash !== "#arch" || still()) return;
    entered = true;
    svg.classList.add("is-entering");
    setTimeout(() => svg.classList.remove("is-entering"), 1400);
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (pinned || touring)) { pinned = null; stopTour(); select(null); } });
  matchMedia("(max-width: 720px)").addEventListener("change", draw);
  window.addEventListener("hashchange", () => { if (location.hash !== "#arch") stopTour(); enter(); });
  window.addEventListener("DOMContentLoaded", () => {
    draw();
    root.replaceChildren(figure, detail);
    enter();
  });
})();
