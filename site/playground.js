// In-browser playground: a terraform CLI over a modelled configuration, state
// and cloud. Visitors type terraform commands to find and fix one fault per
// scenario. No real provider runs and nothing leaves the browser: the "AWS"
// here is a small model of the API calls Terraform makes, with real errors.
//
// The simulator (TQSim) has no DOM access so tests/check_playground.js can
// drive it under Node; the UI below it only renders what the simulator says.
"use strict";

(function (root) {
  const H = root.TQHCL;
  const { UNKNOWN, Sens, unmark, strip, show } = H;
  const CLI = "1.10.5";
  const ACCOUNT = "111122223333";
  const LAPTOP = "darwin_arm64";
  const RUNNER = "linux_amd64";
  const REGION = "eu-west-1";

  // --- versions and the registry ------------------------------------------------

  const PROVIDERS = {
    aws: { source: "hashicorp/aws", versions: ["4.67.0", "5.31.0", "5.80.0", "6.2.0"] },
    random: { source: "hashicorp/random", versions: ["3.5.1", "3.6.3"] }
  };
  const CLI_VERSIONS = ["1.5.7", "1.9.8", "1.10.5"];

  const vparts = (v) => String(v).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  function vcmp(a, b) {
    const x = vparts(a);
    const y = vparts(b);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  }
  // Terraform's version constraints: =, !=, >, >=, <, <=, ~> joined by commas.
  function satisfies(version, constraint) {
    if (!constraint || !String(constraint).trim()) return true;
    return String(constraint).split(",").every((part) => {
      const m = /^\s*(=|!=|>=|<=|>|<|~>)?\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(part);
      if (!m) return false;
      const [op = "=", want] = [m[1], m[2]];
      const c = vcmp(version, want);
      if (op === "~>") {
        const w = vparts(want);
        const n = want.split(".").length;
        const upper = n === 1 ? [w[0] + 1, 0, 0] : n === 2 ? [w[0] + 1, 0, 0] : [w[0], w[1] + 1, 0];
        return c >= 0 && vcmp(version, upper.join(".")) < 0;
      }
      return { "=": c === 0, "!=": c !== 0, ">": c > 0, ">=": c >= 0, "<": c < 0, "<=": c <= 0 }[op];
    });
  }
  const validConstraint = (c) => String(c).split(",").every((p) => /^\s*(=|!=|>=|<=|>|<|~>)?\s*v?\d+(\.\d+){0,2}\s*$/.test(p));

  // Edit distance, for "Did you mean ...?".
  function closest(word, options) {
    let best = null;
    let score = 3;
    for (const o of options) {
      const d = Array.from({ length: word.length + 1 }, (_, i) => [i]);
      for (let j = 1; j <= o.length; j++) d[0][j] = j;
      for (let i = 1; i <= word.length; i++) {
        for (let j = 1; j <= o.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (word[i - 1] === o[j - 1] ? 0 : 1));
      }
      if (d[word.length][o.length] < score) { score = d[word.length][o.length]; best = o; }
    }
    return best;
  }

  // --- provider schemas -----------------------------------------------------------

  // "name:flags": r required, n forces replacement, c computed when unset,
  // s sensitive. Blocks list their own arguments the same way.
  const spec = (s) => Object.fromEntries(s.trim().split(/\s+/).map((x) => { const [n, f = ""] = x.split(":"); return [n, f]; }));
  const RESOURCES = {
    aws_s3_bucket: { args: spec("bucket:nc bucket_prefix:n force_destroy tags"), prefix: null, computed: ["arn", "bucket_domain_name", "region"], data: true },
    aws_s3_bucket_acl: { args: spec("bucket:rn acl expected_bucket_owner:n"), prefix: null },
    aws_s3_bucket_ownership_controls: { args: spec("bucket:rn"), blocks: { rule: spec("object_ownership:r") }, prefix: null },
    aws_s3_bucket_public_access_block: { args: spec("bucket:rn block_public_acls block_public_policy ignore_public_acls restrict_public_buckets"), prefix: null },
    aws_s3_bucket_policy: { args: spec("bucket:rn policy:r"), prefix: null },
    aws_s3_bucket_versioning: { args: spec("bucket:rn"), blocks: { versioning_configuration: spec("status:r") }, prefix: null },
    aws_instance: { args: spec("ami:rn instance_type:c subnet_id:nc vpc_security_group_ids:c iam_instance_profile user_data:n key_name:n associate_public_ip_address:nc tags"), prefix: "i-", computed: ["arn", "private_ip", "public_ip", "instance_state"] },
    aws_db_instance: {
      args: spec("identifier:nc engine:rn engine_version:c instance_class:r allocated_storage:c username:nc password:s manage_master_user_password db_name:nc storage_encrypted:nc skip_final_snapshot final_snapshot_identifier deletion_protection publicly_accessible multi_az backup_retention_period:c vpc_security_group_ids:c tags"),
      prefix: "db-", computed: ["arn", "address", "endpoint", "master_user_secret"], data: true
    },
    aws_security_group: {
      args: spec("name:nc name_prefix:n description:n vpc_id:nc tags"), prefix: "sg-", computed: ["arn", "owner_id"],
      blocks: { ingress: spec("from_port:r to_port:r protocol:r cidr_blocks security_groups description"), egress: spec("from_port:r to_port:r protocol:r cidr_blocks security_groups description") }
    },
    aws_vpc_security_group_ingress_rule: { args: spec("security_group_id:rn ip_protocol:r from_port to_port cidr_ipv4 referenced_security_group_id description tags"), prefix: "sgr-", computed: ["arn"] },
    aws_vpc_security_group_egress_rule: { args: spec("security_group_id:rn ip_protocol:r from_port to_port cidr_ipv4 referenced_security_group_id description tags"), prefix: "sgr-", computed: ["arn"] },
    aws_vpc: { args: spec("cidr_block:n enable_dns_hostnames tags"), prefix: "vpc-", computed: ["arn"] },
    aws_subnet: { args: spec("vpc_id:rn cidr_block:n availability_zone:nc map_public_ip_on_launch tags"), prefix: "subnet-", computed: ["arn"] },
    aws_autoscaling_group: { args: spec("name:nc min_size:r max_size:r desired_capacity:c vpc_zone_identifier:c tags"), blocks: { launch_template: spec("id name version") }, prefix: null, computed: ["arn"] },
    aws_launch_template: { args: spec("name:nc image_id instance_type"), prefix: "lt-", computed: ["arn", "latest_version"] },
    aws_iam_role: { args: spec("name:nc assume_role_policy:r tags"), prefix: null, computed: ["arn", "unique_id"] },
    aws_iam_instance_profile: { args: spec("name:nc role"), prefix: null, computed: ["arn"] },
    aws_acm_certificate: { args: spec("domain_name:rn validation_method:n provider_region"), prefix: null, computed: ["arn", "status"] },
    aws_cloudfront_distribution: { args: spec("enabled:r aliases comment tags"), blocks: { viewer_certificate: spec("acm_certificate_arn ssl_support_method minimum_protocol_version") }, prefix: "E", computed: ["arn", "domain_name"] },
    aws_dynamodb_table: { args: spec("name:rn billing_mode hash_key:rn tags"), blocks: { attribute: spec("name:r type:r") }, prefix: null, computed: ["arn"] },
    random_password: { args: spec("length:rn special:n"), prefix: "none", computed: ["result"] }
  };
  const DATA_SOURCES = {
    aws_vpc: { args: spec("id:c default tags:c"), blocks: { filter: spec("name:r values:r") } },
    aws_ami: { args: spec("most_recent owners name_regex"), blocks: { filter: spec("name:r values:r") } },
    aws_caller_identity: { args: {} },
    aws_region: { args: {} },
    aws_availability_zones: { args: spec("state") },
    aws_iam_policy_document: { args: {}, blocks: { statement: spec("sid effect actions resources") } },
    aws_subnets: { args: {}, blocks: { filter: spec("name:r values:r") } }
  };
  const META = new Set(["count", "for_each", "depends_on", "provider", "lifecycle", "provisioner", "connection"]);
  const LIFECYCLE = new Set(["create_before_destroy", "prevent_destroy", "ignore_changes", "replace_triggered_by", "precondition", "postcondition"]);
  const TOP = ["terraform", "provider", "variable", "locals", "output", "resource", "data", "module", "moved", "import", "removed", "check"];
  const providerOf = (type) => type.split("_")[0];

  // --- diagnostics -----------------------------------------------------------------

  // Terraform's boxed diagnostics, wrapped to its line width.
  function wrap(text, width = 75) {
    const out = [];
    for (const para of String(text).split("\n")) {
      if (/^\s/.test(para) || para.length <= width) { out.push(para); continue; }
      let line = "";
      for (const word of para.split(" ")) {
        if (line && (line + " " + word).length > width) { out.push(line); line = word; } else line = line ? line + " " + word : word;
      }
      out.push(line);
    }
    return out;
  }
  const diag = (summary, detail, at, sev = "Error") => ({ sev, summary, detail, at });
  function renderDiag(w, d) {
    const lines = ["╷", `│ ${d.sev}: ${d.summary}`];
    if (d.at && d.at.file) {
      const src = (w.fs[d.at.file] || "").split("\n")[d.at.line - 1];
      lines.push("│ ");
      if (d.at.with) lines.push(`│   with ${d.at.with},`);
      lines.push(`│   on ${d.at.file} line ${d.at.line}${d.at.ctx ? `, in ${d.at.ctx}` : ""}:`);
      if (src !== undefined) lines.push(`│ ${String(d.at.line).padStart(4)}: ${src}`);
    }
    if (d.detail) {
      lines.push("│ ");
      for (const l of wrap(d.detail)) lines.push(l ? `│ ${l}` : "│ ");
    }
    lines.push("╵");
    return lines.map((t) => [t, d.sev === "Error" ? "warn" : "note"]);
  }

  // A seeded generator, so ids and lock times are the same on every run.
  function seeded(text) {
    let s = [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  // --- the working directory, state and the modelled cloud ---------------------------

  const dirOf = (f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
  const emptyState = (w) => ({ version: 4, tfv: w.cli, serial: 0, lineage: w.uuid(), resources: {}, outputs: {} });
  const clone = (x) => JSON.parse(JSON.stringify(x));

  class World {
    constructor(scenario, base) {
      this.scenario = scenario;
      this.rand = seeded(scenario.id);
      this.fs = { ...scenario.files };
      this.env = { AWS_PROFILE: "quest", ...(scenario.env || {}) };
      if (scenario.noCredentials) delete this.env.AWS_PROFILE;
      this.cli = scenario.cli || CLI;
      this.installed = new Set([CLI, this.cli]);
      this.platform = LAPTOP;
      this.dot = null;
      this.ws = "default";
      this.stores = {};
      this.locks = {};
      this.cloud = {};
      this.lost = [];
      this.applied = [];
      this.planFiles = {};
      this.ciRuns = [];
      this.pending = null;
      this.console = false;
      this.status = 0;
      this.clock = 0;
      this.mirror = Boolean(scenario.mirror);
      this.memo = {};
      if (base) return;
      for (const o of scenario.cloud || []) this.cloudPut(o.type, o.id, o.attrs, o.extra);
      if (scenario.setup) scenario.setup(this);
      this.status = 0;
    }

    hex(n) { let s = ""; while (s.length < n) s += this.rand().toString(16).padStart(8, "0"); return s.slice(0, n); }
    uuid() { const x = this.hex(32); return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20)}`; }

    cloudPut(type, id, attrs, extra) { this.cloud[`${type}/${id}`] = { type, id, attrs: { id, ...attrs }, extra: { ...(extra || {}) } }; }
    cloudGet(type, id) { return this.cloud[`${type}/${id}`]; }
    cloudAll(type) { return Object.values(this.cloud).filter((o) => o.type === type); }

    storeKey() {
      const be = this.dot && this.dot.backend;
      return be && be.type === "s3" ? `s3://${be.cfg.bucket}/${be.cfg.key}` : "local";
    }
    states(key = this.storeKey()) { return (this.stores[key] = this.stores[key] || { default: null }); }
    get state() {
      const all = this.states();
      if (!all[this.ws]) all[this.ws] = emptyState(this);
      return all[this.ws];
    }
    set state(st) { this.states()[this.ws] = st; }
    hasState() { const st = this.states()[this.ws]; return Boolean(st && (Object.keys(st.resources).length || Object.keys(st.outputs).length)); }

    // The files git would commit: everything except what .gitignore lists.
    ignored(file) {
      const pats = (this.fs[".gitignore"] || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      return file.startsWith(".terraform/") || pats.some((p) => {
        const rx = new RegExp("^(.*/)?" + p.replace(/^\*\*\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\/$/, "/.*") + "$");
        return rx.test(file);
      });
    }

    run(line) { return shell(this, line); }
  }

  // Run setup commands; a scenario that cannot build its own start is a bug.
  function quietly(w, ...cmds) {
    for (const cmd of cmds) {
      const out = shell(w, cmd);
      const bad = out.find(([t, c]) => c === "warn" && /Error/.test(t));
      if (bad || w.status) throw new Error(`setup of ${w.scenario.id}: "${cmd}" failed: ${out.map(([t]) => t).join("\n")}`);
    }
  }

  // --- reading the configuration ---------------------------------------------------

  const tfFiles = (w, dir) => Object.keys(w.fs).filter((f) => dirOf(f) === dir && f.endsWith(".tf")).sort();

  // "aws_s3_bucket.logs", "aws_s3_bucket.team[0]", "module.vpc.aws_vpc.this" from a traversal.
  function travText(node) {
    if (!node) return null;
    if (node.k === "var") return node.name;
    if (node.k !== "get" || node.base.k !== "var") return null;
    let s = node.base.name;
    for (const st of node.steps) {
      if ("a" in st) s += "." + st.a;
      else if (st.i && st.i.k === "lit") s += typeof st.i.v === "number" ? `[${st.i.v}]` : `[${JSON.stringify(st.i.v)}]`;
      else return null;
    }
    return s;
  }

  // Values that must be known while reading the configuration, such as the
  // backend block and required_providers: no variables or references allowed.
  function constant(expr, at, diags, what = "Variables may not be used here.") {
    try {
      return strip(H.evaluate(expr, { scope: () => { throw new H.EvalError("Variables not allowed", what, expr.line); } }));
    } catch (e) {
      if (!(e instanceof H.EvalError)) throw e;
      diags.push(diag(e.summary, e.detail, { ...at, line: e.line || at.line }));
      return undefined;
    }
  }

  function readModule(w, dir, mp, diags) {
    const mod = { mp, dir, vars: {}, locals: {}, outputs: {}, res: [], data: [], calls: [], providers: [], req: {}, reqVersion: [], backend: null, moved: [], imports: [], removed: [] };
    const where = mp ? `module "${mp.split(".").pop()}"` : "the root module";
    for (const file of tfFiles(w, dir)) {
      let body;
      try { body = H.parse(w.fs[file]); } catch (e) {
        if (!(e instanceof H.HCLError)) throw e;
        diags.push(diag(e.summary, e.detail, { file, line: e.line }));
        continue;
      }
      for (const b of body.blocks) {
        const at = { file, line: b.line };
        const ctx = (kind) => ({ ...at, ctx: `${kind}${b.labels.map((l) => ` "${l}"`).join("")}` });
        if (b.type === "terraform") {
          if (b.attrs.required_version) mod.reqVersion.push({ value: constant(b.attrs.required_version.expr, at, diags), at: { file, line: b.attrs.required_version.line, ctx: "terraform" } });
          for (const sub of b.blocks) {
            if (sub.type === "required_providers") {
              for (const a of Object.values(sub.attrs)) {
                const v = constant(a.expr, { file, line: a.line }, diags);
                mod.req[a.name] = typeof v === "string" ? { source: `hashicorp/${a.name}`, version: v, line: a.line, file } : { source: (v && v.source) || `hashicorp/${a.name}`, version: v && v.version, line: a.line, file };
              }
            } else if (sub.type === "backend" || sub.type === "cloud") {
              const cfg = {};
              for (const a of Object.values(sub.attrs)) cfg[a.name] = constant(a.expr, { file, line: a.line, ctx: `terraform` }, diags);
              mod.backend = { type: sub.type === "cloud" ? "cloud" : sub.labels[0], cfg, file, line: sub.line };
            }
          }
          continue;
        }
        if (b.type === "provider") { mod.providers.push({ name: b.labels[0], block: b, file, at: ctx("provider") }); continue; }
        if (b.type === "variable") {
          const a = b.attrs;
          mod.vars[b.labels[0]] = {
            name: b.labels[0], at: { file, line: b.line }, default: a.default ? a.default.expr : undefined, type: a.type ? a.type.expr : null,
            sensitive: a.sensitive ? constant(a.sensitive.expr, at, diags) === true : false,
            validations: b.blocks.filter((x) => x.type === "validation").map((x) => ({ cond: x.attrs.condition && x.attrs.condition.expr, msg: x.attrs.error_message ? constant(x.attrs.error_message.expr, at, diags) : "", line: x.line, file }))
          };
          continue;
        }
        if (b.type === "locals") { for (const a of Object.values(b.attrs)) mod.locals[a.name] = { expr: a.expr, at: { file, line: a.line, ctx: "locals" } }; continue; }
        if (b.type === "output") {
          if (!b.attrs.value) { diags.push(diag("Missing required argument", 'The argument "value" is required, but no definition was found.', ctx("output"))); continue; }
          mod.outputs[b.labels[0]] = { name: b.labels[0], expr: b.attrs.value.expr, sensitive: b.attrs.sensitive ? constant(b.attrs.sensitive.expr, at, diags) === true : false, at: { file, line: b.attrs.value.line, ctx: `output "${b.labels[0]}"` }, block: b };
          continue;
        }
        if (b.type === "resource" || b.type === "data") {
          if (b.labels.length !== 2) { diags.push(diag(`Missing name for ${b.type === "data" ? "data source" : "resource"}`, `All ${b.type} blocks must have 2 labels (type, name).`, at)); continue; }
          const [type, name] = b.labels;
          const list = b.type === "data" ? mod.data : mod.res;
          const dup = list.find((r) => r.type === type && r.name === name);
          if (dup) { diags.push(diag(`Duplicate ${b.type === "data" ? "data" : "resource"} "${type}" configuration`, `A ${type} ${b.type === "data" ? "data resource" : "resource"} named "${name}" was already declared at ${dup.at.file}:${dup.at.line}. Resource names must be unique per type in each module.`, at)); continue; }
          const lc = b.blocks.find((x) => x.type === "lifecycle");
          list.push({ mode: b.type === "data" ? "data" : "managed", type, name, block: b, at: ctx(b.type), mp, lifecycle: lc || null, id: `${mp ? mp + "." : ""}${b.type === "data" ? "data." : ""}${type}.${name}` });
          continue;
        }
        if (b.type === "module") {
          const inputs = Object.values(b.attrs).filter((a) => !["source", "version", "count", "for_each", "depends_on", "providers"].includes(a.name));
          if (!b.attrs.source) { diags.push(diag("Missing required argument", 'The argument "source" is required, but no definition was found.', ctx("module"))); continue; }
          mod.calls.push({ name: b.labels[0], block: b, at: ctx("module"), source: constant(b.attrs.source.expr, at, diags), version: b.attrs.version ? constant(b.attrs.version.expr, at, diags) : null, inputs, mp });
          continue;
        }
        if (b.type === "moved") { mod.moved.push({ from: travText(b.attrs.from && b.attrs.from.expr), to: travText(b.attrs.to && b.attrs.to.expr), at }); continue; }
        if (b.type === "import") { mod.imports.push({ to: travText(b.attrs.to && b.attrs.to.expr), id: b.attrs.id ? constant(b.attrs.id.expr, at, diags) : null, at }); continue; }
        if (b.type === "removed") {
          const lc = b.blocks.find((x) => x.type === "lifecycle");
          mod.removed.push({ from: travText(b.attrs.from && b.attrs.from.expr), destroy: !(lc && lc.attrs.destroy && constant(lc.attrs.destroy.expr, at, diags) === false), at });
          continue;
        }
        if (b.type === "check") continue;
        const guess = closest(b.type, TOP);
        diags.push(diag("Unsupported block type", `Blocks of type "${b.type}" are not expected here.${guess ? ` Did you mean "${guess}"?` : ""}`, at));
      }
    }
    mod.where = where;
    return mod;
  }

  // Where a module call's files live: a local path, or what init downloaded.
  function moduleDir(w, call, parent, diags) {
    const key = call.mp ? `${call.mp}.${call.name}` : call.name;
    const installed = w.dot && w.dot.modules && w.dot.modules[key];
    if (!installed) {
      diags.push(diag("Module not installed", 'This module is not yet installed. Run "terraform init" to install all modules required by this configuration.', call.at));
      return null;
    }
    if (installed.source !== call.source) {
      diags.push(diag("Module source has changed", 'The source address was changed since this module was installed. Run "terraform init" to install all modules required by this configuration.', call.at));
      return null;
    }
    if (installed.version && call.version && !satisfies(installed.version, call.version)) {
      diags.push(diag("Module version requirements have changed", `The version requirements have changed since this module was installed and the installed version (${installed.version}) is no longer acceptable. Run "terraform init" to install all modules required by this configuration.`, call.at));
      return null;
    }
    return installed.dir;
  }

  function loadConfig(w) {
    const diags = [];
    const mods = {};
    const load = (dir, mp, depth) => {
      const mod = readModule(w, dir, mp, diags);
      mods[mp] = mod;
      for (const call of mod.calls) {
        const childDir = moduleDir(w, call, mod, diags);
        if (childDir === null || depth > 4) continue;
        call.child = `${mp ? mp + "." : ""}module.${call.name}`;
        load(childDir, call.child, depth + 1);
      }
    };
    load("", "", 0);
    return { mods, root: mods[""], diags };
  }

  // Every provider the configuration needs, with each module's constraints.
  function requirements(cfg) {
    const need = {};
    for (const mod of Object.values(cfg.mods)) {
      const names = new Set([...Object.keys(mod.req), ...mod.res.map((r) => providerOf(r.type)), ...mod.data.map((r) => providerOf(r.type)), ...mod.providers.map((p) => p.name)]);
      for (const n of names) {
        const r = need[n] = need[n] || { name: n, source: `hashicorp/${n}`, constraints: [] };
        if (mod.req[n]) {
          r.source = mod.req[n].source;
          if (mod.req[n].version) r.constraints.push({ value: mod.req[n].version, mp: mod.mp });
        }
      }
    }
    return Object.values(need);
  }

  // --- checking the configuration --------------------------------------------------

  const keyed = (id, key) => (key === undefined ? id : typeof key === "number" ? `${id}[${key}]` : `${id}[${JSON.stringify(key)}]`);
  const schemaOf = (r) => (r.mode === "data" ? DATA_SOURCES : RESOURCES)[r.type];
  const exported = (S) => new Set(["id", ...Object.keys(S.args), ...Object.keys(S.blocks || {}), ...(S.computed || []), ...(S === DATA_SOURCES.aws_iam_policy_document ? ["json"] : []), ...(S === DATA_SOURCES.aws_vpc ? ["cidr_block", "arn"] : []), ...(S === DATA_SOURCES.aws_caller_identity ? ["account_id", "arn"] : []), ...(S === DATA_SOURCES.aws_region ? ["name"] : []), ...(S === DATA_SOURCES.aws_availability_zones ? ["names"] : []), ...(S === DATA_SOURCES.aws_subnets ? ["ids"] : [])]);

  function validateResource(r, diags) {
    const S = schemaOf(r);
    const b = r.block;
    if (!S) {
      const guess = closest(r.type, Object.keys(r.mode === "data" ? DATA_SOURCES : RESOURCES));
      diags.push(diag(`Invalid ${r.mode === "data" ? "data source" : "resource type"}`, `The provider hashicorp/${providerOf(r.type)} does not support ${r.mode === "data" ? "data source" : "resource type"} "${r.type}".${guess ? ` Did you mean "${guess}"?` : ""}`, r.at));
      return;
    }
    const check = (attrs, blocks, args, nested, at) => {
      for (const a of Object.values(attrs)) {
        if (!nested && META.has(a.name)) continue;
        if (!(a.name in args)) {
          const guess = closest(a.name, Object.keys(args));
          diags.push(diag("Unsupported argument", `An argument named "${a.name}" is not expected here.${guess ? ` Did you mean "${guess}"?` : ""}`, { ...at, line: a.line }));
        }
      }
      for (const [name, flags] of Object.entries(args)) {
        if (flags.includes("r") && !attrs[name]) diags.push(diag("Missing required argument", `The argument "${name}" is required, but no definition was found.`, at));
      }
      for (const sub of blocks) {
        if (!nested && sub.type === "lifecycle") {
          for (const a of Object.values(sub.attrs)) if (!LIFECYCLE.has(a.name)) diags.push(diag("Unsupported argument", `An argument named "${a.name}" is not expected here.`, { ...at, line: a.line }));
          continue;
        }
        if (!nested && ["provisioner", "connection", "dynamic"].includes(sub.type)) continue;
        const inner = (S.blocks || {})[sub.type];
        if (nested || !inner) {
          const guess = closest(sub.type, Object.keys(S.blocks || {}));
          diags.push(diag("Unsupported block type", `Blocks of type "${sub.type}" are not expected here.${guess ? ` Did you mean "${guess}"?` : ""}`, { ...at, line: sub.line }));
          continue;
        }
        check(sub.attrs, sub.blocks, inner, true, { ...at, line: sub.line });
      }
    };
    check(b.attrs, b.blocks, S.args, false, r.at);
  }

  // Expressions a node reads, and the addresses its depends_on names.
  function blockExprs(b, out = []) {
    for (const a of Object.values(b.attrs)) if (a.name !== "depends_on" && a.name !== "provider") out.push(a.expr);
    for (const sub of b.blocks) if (sub.type !== "lifecycle") blockExprs(sub, out);
    return out;
  }
  const dependsOn = (b) => (b.attrs.depends_on && b.attrs.depends_on.expr.k === "list" ? b.attrs.depends_on.expr.items.map(travText).filter(Boolean) : []);

  function nodeExprs(n) {
    const it = n.item;
    if (n.kind === "local") return [it.expr];
    if (n.kind === "out") return [it.expr];
    if (n.kind === "call") return [...it.inputs.map((a) => a.expr), ...["count", "for_each"].filter((k) => it.block.attrs[k]).map((k) => it.block.attrs[k].expr)];
    if (n.kind === "res" || n.kind === "data") return blockExprs(it.block);
    return [];
  }

  // Check every reference against what the module declares, with Terraform's messages.
  function checkRefs(cfg, n, diags) {
    const mod = cfg.mods[n.mp];
    const at = n.item.at;
    const counted = (n.kind === "res" || n.kind === "data" || n.kind === "call") && n.item.block.attrs.count;
    const eached = (n.kind === "res" || n.kind === "data" || n.kind === "call") && n.item.block.attrs.for_each;
    const where = mod.where;
    for (const e of nodeExprs(n)) {
      for (const ref of H.refs(e)) {
        const loc = { ...at, line: ref.line || at.line };
        const [a, b] = ref.steps;
        const bad = (s, d) => diags.push(diag(s, d, loc));
        switch (ref.root) {
          case "var":
            if (a === undefined) bad("Invalid reference", 'The "var" object cannot be accessed directly. Instead, access one of its attributes.');
            else if (!mod.vars[a]) bad("Reference to undeclared input variable", `An input variable with the name "${a}" has not been declared. This variable can be declared with a variable "${a}" {} block.`);
            break;
          case "local":
            if (a === undefined) bad("Invalid reference", 'The "local" object cannot be accessed directly. Instead, access one of its attributes.');
            else if (!(a in mod.locals)) bad("Reference to undeclared local value", `A local value with the name "${a}" has not been declared.`);
            break;
          case "count":
            if (!counted) bad('Reference to "count" in non-counted context', 'The "count" object can only be used in "module", "resource", and "data" blocks, and only when the "count" argument is set.');
            break;
          case "each":
            if (!eached) bad('Reference to "each" in context without for_each', 'The "each" object can be used only in "module" or "resource" blocks, and only when the "for_each" argument is set.');
            break;
          case "path": case "terraform": case "self": break;
          case "module": {
            const call = mod.calls.find((c) => c.name === a);
            if (!call) { bad("Reference to undeclared module", `No module call named "${a}" is declared in ${where}.`); break; }
            const child = cfg.mods[call.child];
            if (child && typeof b === "string" && !child.outputs[b]) bad("Unsupported attribute", `This object does not have an attribute named "${b}".`);
            break;
          }
          case "data": {
            const r = mod.data.find((x) => x.type === a && x.name === b);
            if (!r) bad("Reference to undeclared resource", `A data resource "${a}" "${b}" has not been declared in ${where}.`);
            else checkInstanceRef(r, ref.steps.slice(2), `data.${a}.${b}`, bad);
            break;
          }
          default: {
            if (a === undefined) { bad("Invalid reference", "A reference to a resource type must be followed by at least one attribute access, specifying the resource name."); break; }
            const r = mod.res.find((x) => x.type === ref.root && x.name === a);
            if (!r) { bad("Reference to undeclared resource", `A managed resource "${ref.root}" "${a}" has not been declared in ${where}.`); break; }
            checkInstanceRef(r, ref.steps.slice(1), `${ref.root}.${a}`, bad);
          }
        }
      }
    }
  }
  function checkInstanceRef(r, rest, name, bad) {
    const S = schemaOf(r);
    if (!S || !rest.length) return;
    const multi = r.block.attrs.count ? "count" : r.block.attrs.for_each ? "for_each" : null;
    if (multi && typeof rest[0] === "string") {
      bad("Missing resource instance key", `Because ${name} has "${multi}" set, its attributes must be accessed on specific instances.\n\nFor example, to correlate with indices of a referring resource, use:\n    ${name}[${multi === "count" ? "count.index" : "each.key"}]`);
      return;
    }
    const attr = multi ? rest[1] : rest[0];
    if (typeof attr === "string" && !exported(S).has(attr)) bad("Unsupported attribute", `This object has no argument, nested block, or exported attribute named "${attr}".`);
  }

  // The dependency graph: one node per variable, local, resource, data source,
  // output and module call, with edges from references and depends_on.
  function buildGraph(cfg, diags) {
    const nodes = new Map();
    const add = (id, kind, mp, item) => nodes.set(id, { id, kind, mp, item, deps: new Set() });
    for (const mod of Object.values(cfg.mods)) {
      const P = mod.mp ? mod.mp + "." : "";
      for (const v of Object.values(mod.vars)) add(`${P}var.${v.name}`, "var", mod.mp, v);
      for (const [name, l] of Object.entries(mod.locals)) add(`${P}local.${name}`, "local", mod.mp, l);
      for (const r of mod.res) add(r.id, "res", mod.mp, r);
      for (const r of mod.data) add(r.id, "data", mod.mp, r);
      for (const o of Object.values(mod.outputs)) add(`${P}output.${o.name}`, "out", mod.mp, o);
      for (const c of mod.calls) add(`${P}module.${c.name}`, "call", mod.mp, c);
    }
    const inModule = (prefix) => [...nodes.values()].filter((x) => x.id.startsWith(prefix + ".") && (x.kind === "res" || x.kind === "data")).map((x) => x.id);
    for (const n of nodes.values()) {
      const P = n.mp ? n.mp + "." : "";
      if (n.kind === "var" && n.mp) n.deps.add(n.mp);
      for (const e of nodeExprs(n)) {
        for (const ref of H.refs(e)) {
          const [a, b] = ref.steps;
          let target = [];
          if (ref.root === "var") target = [`${P}var.${a}`];
          else if (ref.root === "local") target = [`${P}local.${a}`];
          else if (ref.root === "module") target = typeof b === "string" ? [`${P}module.${a}.output.${b}`] : [...nodes.keys()].filter((k) => k.startsWith(`${P}module.${a}.output.`));
          else if (ref.root === "data") target = [`${P}data.${a}.${b}`];
          else if (!["count", "each", "path", "terraform", "self"].includes(ref.root)) target = [`${P}${ref.root}.${a}`];
          for (const t of target) if (nodes.has(t) && t !== n.id) n.deps.add(t);
          for (const t of target) if (t === n.id) n.self = true;
        }
      }
      if (n.kind === "res" || n.kind === "data" || n.kind === "call" || n.kind === "out") {
        const block = n.item.block;
        n.explicit = new Set();
        for (const d of dependsOn(block)) {
          const id = P + d;
          const targets = nodes.has(id) && nodes.get(id).kind !== "call" ? [id] : d.startsWith("module.") ? inModule(id) : [];
          for (const t of targets) { n.deps.add(t); n.explicit.add(t); }
        }
      }
    }
    // A module's nodes also wait for whatever its call waits for.
    for (const n of nodes.values()) {
      if (!n.mp) continue;
      const call = nodes.get(n.mp);
      if (call && call.explicit) { n.inherited = call.explicit; for (const d of call.explicit) n.deps.add(d); }
    }
    // Cycles, as Terraform reports them.
    let index = 0;
    const idx = new Map();
    const low = new Map();
    const stack = [];
    const on = new Set();
    const sccs = [];
    const visit = (v) => {
      idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
      for (const d of nodes.get(v).deps) {
        if (!idx.has(d)) { visit(d); low.set(v, Math.min(low.get(v), low.get(d))); } else if (on.has(d)) low.set(v, Math.min(low.get(v), idx.get(d)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let x;
        do { x = stack.pop(); on.delete(x); comp.push(x); } while (x !== v);
        if (comp.length > 1 || nodes.get(v).self) sccs.push(comp);
      }
    };
    for (const k of nodes.keys()) if (!idx.has(k)) visit(k);
    for (const comp of sccs) diags.push(diag(`Cycle: ${comp.filter((x) => !/(^|\.)var\./.test(x)).reverse().join(", ")}`, null, null));
    // A topological order (dependencies first).
    const order = [];
    const done = new Set();
    const walk = (k, trail) => {
      if (done.has(k) || trail.has(k)) return;
      trail.add(k);
      for (const d of nodes.get(k).deps) walk(d, trail);
      done.add(k);
      order.push(nodes.get(k));
    };
    for (const k of nodes.keys()) walk(k, new Set());
    return { nodes, order };
  }

  // Everything `terraform validate` checks without values: syntax, block and
  // argument names, references and cycles.
  function staticCheck(w, cfg) {
    const diags = [...cfg.diags];
    if (diags.length) return { diags };
    for (const mod of Object.values(cfg.mods)) {
      for (const r of [...mod.res, ...mod.data]) validateResource(r, diags);
      for (const call of mod.calls) {
        const child = call.child && cfg.mods[call.child];
        if (!child) continue;
        for (const a of call.inputs) {
          if (!child.vars[a.name]) {
            const guess = closest(a.name, Object.keys(child.vars));
            diags.push(diag("Unsupported argument", `An argument named "${a.name}" is not expected here.${guess ? ` Did you mean "${guess}"?` : ""}`, { ...call.at, line: a.line }));
          }
        }
        for (const v of Object.values(child.vars)) {
          if (v.default === undefined && !call.inputs.some((a) => a.name === v.name)) diags.push(diag(`Missing required argument`, `The argument "${v.name}" is required, but no definition was found.`, call.at));
        }
      }
    }
    for (const mod of Object.values(cfg.mods)) {
      for (const rm of mod.removed) {
        const r = mod.res.find((x) => x.id === (mod.mp ? mod.mp + "." : "") + rm.from);
        if (r) diags.push(diag("Removed resource still exists", `This statement declares that ${rm.from} was removed, but it is still declared in configuration.`, rm.at));
      }
      for (const r of [...mod.res, ...mod.data]) {
        const pa = r.block.attrs.provider;
        const name = pa && travText(pa.expr);
        if (!name || !name.includes(".")) continue;
        const [pn, alias] = name.split(".");
        const ok = cfg.root.providers.some((x) => x.name === pn && x.block.attrs.alias && constant(x.block.attrs.alias.expr, x.at, []) === alias);
        if (!ok) diags.push(diag("Provider configuration not present", `To work with ${r.id} its original provider configuration at provider["${REG(pn)}"].${alias} is required, but it has been removed. This occurs when a provider configuration is removed while objects created by that provider still exist in the state. Re-add the provider configuration to destroy ${r.id}, after which you can remove the provider configuration again.`, { ...r.at, line: pa.line }));
      }
    }
    if (diags.length) return { diags };
    const graph = buildGraph(cfg, diags);
    for (const n of graph.nodes.values()) checkRefs(cfg, n, diags);
    return { diags, graph };
  }

  // --- variables ---------------------------------------------------------------------

  const asSet = (list) => Object.defineProperty(list, "tqSet", { value: true });
  // Convert a value to a variable's declared type, as Terraform does.
  function convert(v, t) {
    if (!t || v === null || v === UNKNOWN) return v;
    if (v instanceof Sens) return new Sens(convert(v.v, t));
    if (t.k === "var") {
      if (t.name === "any") return v;
      if (t.name === "string") { if (["string", "number", "boolean"].includes(typeof v)) return String(v); throw new Error("string required"); }
      if (t.name === "number") { const n = typeof v === "string" && v.trim() ? Number(v) : v; if (typeof n === "number" && !Number.isNaN(n)) return n; throw new Error("a number is required"); }
      if (t.name === "bool") { if (typeof v === "boolean") return v; if (v === "true" || v === "false") return v === "true"; throw new Error("a bool is required"); }
    }
    if (t.k === "call") {
      const inner = t.args[0];
      if (["list", "set", "tuple"].includes(t.name)) {
        if (!Array.isArray(v)) throw new Error(`${t.name} of ${inner && inner.name ? inner.name : "any"} required`);
        const out = v.map((x) => convert(x, t.name === "tuple" ? null : inner));
        return t.name === "set" ? asSet([...new Set(out)].sort()) : out;
      }
      if (t.name === "map" || t.name === "object") {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${t.name} required`);
        if (t.name === "map") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x, inner)]));
        const out = {};
        for (const it of (inner && inner.items) || []) {
          const k = it.key.k === "var" ? it.key.name : it.key.v;
          if (!(k in v)) throw new Error(`attribute "${k}" is required`);
          out[k] = convert(v[k], it.val);
        }
        return out;
      }
    }
    return v;
  }

  function readTfvars(w, file, diags) {
    if (!(file in w.fs)) { diags.push(diag("Failed to read variables file", `Given variables file ${file} does not exist.`)); return {}; }
    let body;
    try { body = H.parse(w.fs[file]); } catch (e) {
      if (!(e instanceof H.HCLError)) throw e;
      diags.push(diag(e.summary, e.detail, { file, line: e.line }));
      return {};
    }
    const out = {};
    for (const a of Object.values(body.attrs)) out[a.name] = { value: constant(a.expr, { file, line: a.line }, diags), file, line: a.line };
    return out;
  }

  // Root module variables, from lowest to highest precedence: default, TF_VAR_
  // environment variables, terraform.tfvars, *.auto.tfvars, then -var and
  // -var-file in the order given on the command line.
  function rootVars(w, cfg, opts, diags) {
    const decl = cfg.root.vars;
    const got = {};
    const fromText = (name, text) => {
      const v = decl[name];
      if (!v.type || (v.type.k === "var" && v.type.name === "string")) return text;
      try { return strip(H.evaluate(H.parseExpr(text, 1), { scope: () => { throw new H.EvalError("Variables not allowed", "Variables may not be used here.", 1); } })); } catch { return text; }
    };
    for (const [k, text] of Object.entries(w.env)) {
      const m = /^TF_VAR_(.+)$/.exec(k);
      if (m && decl[m[1]] && text !== undefined) got[m[1]] = fromText(m[1], text);
    }
    const files = ["terraform.tfvars", ...Object.keys(w.fs).filter((f) => !f.includes("/") && f.endsWith(".auto.tfvars")).sort()];
    const fromFile = (file, values) => {
      for (const [k, x] of Object.entries(values)) {
        if (decl[k]) got[k] = x.value;
        else diags.push(diag("Value for undeclared variable", `The root module does not declare a variable named "${k}" but a value was found in file "${file}". If you meant to use this value, add a "variable" block to the configuration.\n\nTo silence these warnings, use TF_VAR_... environment variables to provide certain "global" settings to all configurations in your organization. To reduce the verbosity of these warnings, use the -compact-warnings option.`, { file, line: x.line }, "Warning"));
      }
    };
    for (const f of files) if (f in w.fs) fromFile(f, readTfvars(w, f, diags));
    for (const v of opts.vars || []) {
      if (v.file) fromFile(v.file, readTfvars(w, v.file, diags));
      else if (!decl[v.name]) diags.push(diag("Value for undeclared variable", `A variable named "${v.name}" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.`));
      else got[v.name] = fromText(v.name, v.value);
    }
    const values = {};
    const missing = [];
    for (const v of Object.values(decl)) {
      let x = got[v.name];
      if (x === undefined) {
        if (v.default === undefined) { if (!opts.validateOnly) missing.push(v); x = UNKNOWN; } else x = constant(v.default, v.at, diags);
      }
      try { x = convert(x, v.type); } catch (e) {
        diags.push(diag("Invalid value for input variable", `The given value is not suitable for var.${v.name} declared at ${v.at.file}:${v.at.line}: ${e.message}.`, null));
      }
      values[v.name] = v.sensitive && x !== undefined ? new Sens(x) : x;
    }
    return { values, missing };
  }

  // --- the modelled cloud API -----------------------------------------------------

  const API = {
    reqId() { return "4f2c9b1e-7a3d-4e6b-9c0a-5d8e2f1b3a7c"; },
    fail(op, what, code, msg, status = 400) {
      const e = new Error(`${op} ${what}: operation error: https response error StatusCode: ${status}, RequestID: ${API.reqId()}, api error ${code}: ${msg}`);
      e.short = `${code}: ${msg}`;
      e.op = op;
      e.what = what;
      throw e;
    }
  };

  // Create a remote object. Rules here are the AWS behaviours the scenarios teach.
  function cloudCreate(w, type, args, region = REGION) {
    const S = RESOURCES[type];
    const name = args.bucket || args.identifier || args.name || args.domain_name;
    if (type === "aws_s3_bucket") {
      const b = args.bucket || `${args.bucket_prefix || "terraform-"}${w.hex(20)}`;
      const other = w.cloudGet("aws_s3_bucket", b);
      if (other) API.fail("creating", `S3 Bucket (${b})`, other.extra.foreign ? "BucketAlreadyExists" : "BucketAlreadyOwnedByYou", other.extra.foreign ? "The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again." : "Your previous request to create the named bucket succeeded and you already own it.", 409);
      args = { ...args, bucket: b };
    }
    if (type === "aws_s3_bucket_acl" && args.acl && args.acl !== "private") {
      const oc = w.cloudAll("aws_s3_bucket_ownership_controls").find((o) => o.attrs.bucket === args.bucket);
      const own = oc ? oc.attrs.rule[0].object_ownership : "BucketOwnerEnforced";
      if (own === "BucketOwnerEnforced") API.fail("creating", `S3 Bucket ACL (${args.bucket},${args.acl})`, "AccessControlListNotSupported", "The bucket does not allow ACLs");
      const pab = w.cloudAll("aws_s3_bucket_public_access_block").find((o) => o.attrs.bucket === args.bucket);
      if (pab && pab.attrs.block_public_acls) API.fail("creating", `S3 Bucket ACL (${args.bucket},${args.acl})`, "AccessDenied", "Access Denied", 403);
    }
    if (type === "aws_security_group" && args.name && w.cloudAll(type).some((o) => o.attrs.name === args.name && o.attrs.vpc_id === args.vpc_id)) {
      API.fail("creating", `Security Group (${args.name})`, "InvalidGroup.Duplicate", `The security group '${args.name}' already exists for VPC '${args.vpc_id}'`);
    }
    if (type === "aws_cloudfront_distribution") {
      const arn = args.viewer_certificate && args.viewer_certificate[0] && args.viewer_certificate[0].acm_certificate_arn;
      if (arn && !arn.includes(":us-east-1:")) API.fail("creating", "CloudFront Distribution", "InvalidViewerCertificate", "The specified SSL certificate doesn't exist, isn't in us-east-1 region, isn't valid, or doesn't include a valid certificate chain.");
    }
    if (type === "aws_instance" && args.iam_instance_profile && !w.cloudGet("aws_iam_instance_profile", args.iam_instance_profile)) {
      API.fail("creating", "EC2 Instance", "InvalidParameterValue", `Value (${args.iam_instance_profile}) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name`);
    }
    const id = type === "aws_acm_certificate" ? `arn:aws:acm:${region}:${ACCOUNT}:certificate/${w.uuid()}` : S.prefix === null ? (type === "aws_s3_bucket" ? args.bucket : name || `${type.replace(/^aws_/, "")}-${w.hex(8)}`) : S.prefix === "none" ? "none" : type === "aws_db_instance" ? `db-${w.hex(26).toUpperCase()}` : S.prefix + "0" + w.hex(16);
    const attrs = { ...args, id };
    const comp = {
      aws_s3_bucket: { arn: `arn:aws:s3:::${id}`, bucket_domain_name: `${id}.s3.amazonaws.com`, region },
      aws_instance: { arn: `arn:aws:ec2:${region}:${ACCOUNT}:instance/${id}`, private_ip: `10.0.1.${20 + (w.rand() % 200)}`, public_ip: "", instance_state: "running", instance_type: args.instance_type || "t3.micro", subnet_id: args.subnet_id || "subnet-0d1e2f3a4b5c6d7e8", vpc_security_group_ids: args.vpc_security_group_ids || [] },
      aws_db_instance: { arn: `arn:aws:rds:${region}:${ACCOUNT}:db:${args.identifier}`, address: `${args.identifier}.c9akciq32.${region}.rds.amazonaws.com`, endpoint: `${args.identifier}.c9akciq32.${region}.rds.amazonaws.com:5432`, engine_version: args.engine_version || "16.4", allocated_storage: args.allocated_storage || 20, master_user_secret: args.manage_master_user_password ? [{ secret_arn: `arn:aws:secretsmanager:${region}:${ACCOUNT}:secret:rds!db-${w.hex(8)}` }] : [], backup_retention_period: args.backup_retention_period ?? 7 },
      aws_security_group: { arn: `arn:aws:ec2:${region}:${ACCOUNT}:security-group/${id}`, owner_id: ACCOUNT, name: args.name || `${args.name_prefix || "terraform-"}${w.hex(10)}`, ingress: args.ingress || [], egress: args.egress || [] },
      aws_vpc_security_group_ingress_rule: { arn: `arn:aws:ec2:${region}:${ACCOUNT}:security-group-rule/${id}` },
      aws_vpc_security_group_egress_rule: { arn: `arn:aws:ec2:${region}:${ACCOUNT}:security-group-rule/${id}` },
      aws_vpc: { arn: `arn:aws:ec2:${region}:${ACCOUNT}:vpc/${id}` },
      aws_subnet: { arn: `arn:aws:ec2:${region}:${ACCOUNT}:subnet/${id}`, availability_zone: args.availability_zone || `${region}a` },
      aws_autoscaling_group: { arn: `arn:aws:autoscaling:${region}:${ACCOUNT}:autoScalingGroup:${w.uuid()}:autoScalingGroupName/${args.name}`, desired_capacity: args.desired_capacity ?? args.min_size, vpc_zone_identifier: args.vpc_zone_identifier || [] },
      aws_launch_template: { arn: `arn:aws:ec2:${region}:${ACCOUNT}:launch-template/${id}`, latest_version: 1 },
      aws_iam_role: { arn: `arn:aws:iam::${ACCOUNT}:role/${args.name}`, unique_id: "AROA" + w.hex(16).toUpperCase() },
      aws_iam_instance_profile: { arn: `arn:aws:iam::${ACCOUNT}:instance-profile/${args.name}` },
      aws_acm_certificate: { arn: id, status: "ISSUED" },
      aws_cloudfront_distribution: { arn: `arn:aws:cloudfront::${ACCOUNT}:distribution/${id}`, domain_name: `d${w.hex(12)}.cloudfront.net` },
      aws_dynamodb_table: { arn: `arn:aws:dynamodb:${region}:${ACCOUNT}:table/${args.name}` },
      random_password: { result: `pw-${w.hex(14)}` }
    }[type] || {};
    w.cloudPut(type, id, { ...attrs, ...comp }, { region, objects: type === "aws_s3_bucket" ? 0 : undefined });
    return w.cloudGet(type, id);
  }

  function cloudDelete(w, type, id) {
    const o = w.cloudGet(type, id);
    if (!o) return;
    if (type === "aws_s3_bucket" && o.extra.objects && !o.attrs.force_destroy) API.fail("deleting", `S3 Bucket (${id})`, "BucketNotEmpty", "The bucket you tried to delete is not empty", 409);
    if (type === "aws_db_instance" && o.attrs.deletion_protection) API.fail("deleting", `RDS DB Instance (${o.attrs.identifier})`, "InvalidParameterCombination", "Cannot delete protected DB Instance, please disable deletion protection and try again.");
    if (type === "aws_db_instance" && !o.attrs.skip_final_snapshot && !o.attrs.final_snapshot_identifier) {
      const e = new Error("final_snapshot_identifier is required when skip_final_snapshot is false");
      e.plain = true;
      throw e;
    }
    if (type === "aws_security_group") {
      const users = Object.values(w.cloud).filter((x) => (x.attrs.vpc_security_group_ids || []).includes(id) || x.attrs.referenced_security_group_id === id);
      if (users.length) API.fail("deleting", `Security Group (${id})`, "DependencyViolation", `resource ${id} has a dependent object`);
    }
    if ((type === "aws_db_instance" || type === "aws_s3_bucket") && (o.extra.objects || type === "aws_db_instance")) w.lost.push({ type, id, name: o.attrs.identifier || o.attrs.bucket });
    delete w.cloud[`${type}/${id}`];
  }

  function cloudUpdate(w, type, id, args) {
    const o = w.cloudGet(type, id);
    const S = RESOURCES[type];
    for (const [n, f] of Object.entries(S.args)) if (!(n in args) && !f.includes("c")) delete o.attrs[n];
    for (const n of Object.keys(S.blocks || {})) if (!(n in args)) o.attrs[n] = [];
    Object.assign(o.attrs, args);
    if (type === "aws_db_instance" && args.manage_master_user_password && !(o.attrs.master_user_secret || []).length) o.attrs.master_user_secret = [{ secret_arn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds!db-${w.hex(8)}` }];
    if (type === "aws_s3_bucket_acl") cloudCreate(w, type, o.attrs);
  }

  // Data sources read the modelled account.
  function readData(w, type, args) {
    const tagOk = (o) => Object.entries(args.tags || {}).every(([k, v]) => (o.attrs.tags || {})[k] === v) &&
      (args.filter || []).every((f) => { const m = /^tag:(.+)$/.exec(f.name); return m ? f.values.includes((o.attrs.tags || {})[m[1]]) : true; });
    if (type === "aws_vpc") {
      const hits = w.cloudAll("aws_vpc").filter((o) => (!args.id || o.id === args.id) && tagOk(o));
      if (hits.length !== 1) throw new Error(hits.length ? "multiple EC2 VPCs matched; use additional constraints to reduce matches to a single EC2 VPC" : "no matching EC2 VPC found");
      return { ...hits[0].attrs };
    }
    if (type === "aws_subnets") return { id: REGION, ids: w.cloudAll("aws_subnet").filter(tagOk).map((o) => o.id).sort() };
    if (type === "aws_ami") return { id: w.scenario.ami || "ami-0c1d2e3f4a5b6c7d8", most_recent: args.most_recent, owners: args.owners };
    if (type === "aws_caller_identity") return { id: ACCOUNT, account_id: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/quest` };
    if (type === "aws_region") return { id: REGION, name: REGION };
    if (type === "aws_availability_zones") return { id: REGION, names: [`${REGION}a`, `${REGION}b`, `${REGION}c`] };
    if (type === "aws_iam_policy_document") {
      const doc = { Version: "2012-10-17", Statement: (args.statement || []).map((s) => ({ ...(s.sid ? { Sid: s.sid } : {}), Effect: s.effect || "Allow", Action: s.actions && s.actions.length === 1 ? s.actions[0] : s.actions, Resource: s.resources && s.resources.length === 1 ? s.resources[0] : s.resources })) };
      return { id: String(JSON.stringify(doc).length), json: JSON.stringify(doc, null, 2) };
    }
    return { id: type };
  }

  // --- planning ------------------------------------------------------------------------

  const SET_LISTS = new Set(["vpc_security_group_ids", "cidr_blocks", "security_groups", "aliases", "vpc_zone_identifier", "actions", "resources", "owners"]);
  function norm(v, name) {
    v = strip(v);
    if (v === undefined || v === null || (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== UNKNOWN && !Array.isArray(v) && !Object.keys(v).length)) return null;
    if (Array.isArray(v)) {
      const items = v.map((x) => norm(x));
      return items.every((x) => typeof x !== "object") ? (SET_LISTS.has(name) ? [...items].sort() : items) : items.map((x) => JSON.stringify(x)).sort();
    }
    if (v && typeof v === "object" && v !== UNKNOWN) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k], k)]));
    return v;
  }
  const same = (a, b, name) => a !== UNKNOWN && b !== UNKNOWN && JSON.stringify(norm(a, name)) === JSON.stringify(norm(b, name));

  // The arguments one instance's configuration sets, evaluated.
  function instanceArgs(r, scope, diags) {
    const S = schemaOf(r);
    const out = {};
    const ev = (a) => {
      try { return H.evaluate(a.expr, { scope, funcs: scope.funcs }); } catch (e) {
        if (!(e instanceof H.EvalError)) throw e;
        diags.push(diag(e.summary, e.detail, { ...r.at, line: e.line || a.line }));
        return UNKNOWN;
      }
    };
    for (const a of Object.values(r.block.attrs)) if (!META.has(a.name) && S.args[a.name] !== undefined) out[a.name] = ev(a);
    for (const b of r.block.blocks) {
      if (!(S.blocks || {})[b.type]) continue;
      const item = {};
      for (const a of Object.values(b.attrs)) item[a.name] = ev(a);
      (out[b.type] = out[b.type] || []).push(item);
    }
    return out;
  }

  function ignored(r) {
    const lc = r.lifecycle && r.lifecycle.attrs.ignore_changes;
    if (!lc) return new Set();
    if (lc.expr.k === "var" && lc.expr.name === "all") return "all";
    const items = lc.expr.k === "list" ? lc.expr.items : [];
    return new Set(items.map((x) => (travText(x) || "").split(/[.[]/)[0]));
  }
  const lcFlag = (r, name) => Boolean(r.lifecycle && r.lifecycle.attrs[name] && unmark(H.evaluate(r.lifecycle.attrs[name].expr, { scope: () => null })) === true);

  function changedArgs(S, after, before, ign) {
    if (ign === "all") return [];
    const names = new Set([...Object.keys(after), ...Object.keys(S.args).filter((n) => !S.args[n].includes("c")), ...Object.keys(S.blocks || {})]);
    return [...names].filter((n) => (S.args[n] !== undefined || (S.blocks || {})[n]) && !ign.has(n) && !same(n in after ? after[n] : null, before[n] ?? null, n)).sort();
  }

  // The full planned value of an instance, for references from elsewhere.
  function plannedValue(r, after, base, fresh) {
    const S = schemaOf(r);
    const v = {};
    for (const n of Object.keys(S.args)) v[n] = null;
    for (const n of Object.keys(S.blocks || {})) v[n] = [];
    if (base && !fresh) {
      Object.assign(v, base);
      for (const [n, f] of Object.entries(S.args)) if (!f.includes("c") && after[n] === undefined) v[n] = null;
      for (const n of Object.keys(S.blocks || {})) if (after[n] === undefined) v[n] = [];
    } else {
      v.id = UNKNOWN;
      for (const c of S.computed || []) v[c] = UNKNOWN;
      for (const [n, f] of Object.entries(S.args)) if (f.includes("c") && after[n] === undefined) v[n] = UNKNOWN;
    }
    for (const [k, x] of Object.entries(after)) v[k] = x;
    return v;
  }

  // The region of the provider configuration a resource uses (provider = aws.alias).
  function regionOf(cfg, r) {
    const want = r && r.block && r.block.attrs.provider ? travText(r.block.attrs.provider.expr) : "aws";
    const alias = want.includes(".") ? want.split(".")[1] : null;
    const prov = cfg.root.providers.find((x) => x.name === "aws" && (x.block.attrs.alias ? constant(x.block.attrs.alias.expr, x.at, []) : null) === alias);
    const reg = prov && prov.block.attrs.region ? constant(prov.block.attrs.region.expr, prov.at, []) : REGION;
    return typeof reg === "string" ? reg : REGION;
  }

  function addrMatches(addr, pattern) {
    return addr === pattern || addr.startsWith(pattern + "[") || addr.startsWith(pattern + ".");
  }

  // opts: { mode: "normal" | "destroy" | "refresh", targets, replace, refresh, vars, validateOnly }
  function makePlan(w, cfg, graph, opts) {
    const diags = [];
    const p = { diags, changes: [], drift: [], moves: [], outputs: {}, refreshers: [], mode: opts.mode || "normal", targets: opts.targets || [] };
    const prior = clone(w.state);
    p.prior = prior;
    // moved blocks, then refresh.
    for (const mod of Object.values(cfg.mods)) {
      const P = mod.mp ? mod.mp + "." : "";
      for (const m of mod.moved) {
        if (!m.from || !m.to) continue;
        for (const addr of Object.keys(prior.resources)) {
          if (!addrMatches(addr, P + m.from)) continue;
          const to = P + m.to + addr.slice((P + m.from).length);
          if (prior.resources[to]) continue;
          prior.resources[to] = { ...prior.resources[addr], addr: to };
          delete prior.resources[addr];
          p.moves.push({ from: addr, to });
        }
      }
    }
    if (opts.refresh !== false && !opts.validateOnly) {
      for (const [addr, r] of Object.entries(prior.resources)) {
        if (r.mode !== "managed") continue;
        const node = graph.nodes.get(addr.replace(/\[[^\]]*\]$/, ""));
        const o = w.cloudGet(r.type, r.id);
        if (!o || (o.extra.region && node && o.extra.region !== regionOf(cfg, node.item))) { p.drift.push({ addr, before: r.attrs, after: null, r }); delete prior.resources[addr]; continue; }
        if (!same(o.attrs, r.attrs)) { p.drift.push({ addr, before: r.attrs, after: clone(o.attrs), r }); r.attrs = clone(o.attrs); }
      }
    }
    const vars = rootVars(w, cfg, opts, diags);
    p.missing = vars.missing;
    if (diags.some((d) => d.sev === "Error") || (vars.missing.length && !opts.validateOnly)) return p;

    const V = {};
    const vmod = (mp) => (V[mp] = V[mp] || { var: {}, local: {}, res: {}, data: {}, mod: {} });
    const scopeFor = (mp, extra) => {
      const f = (name) => {
        if (extra && name in extra) return extra[name];
        const s = vmod(mp);
        if (name === "var") return s.var;
        if (name === "local") return s.local;
        if (name === "module") return s.mod;
        if (name === "data") return s.data;
        if (name === "path") return { module: (cfg.mods[mp] && cfg.mods[mp].dir) || ".", root: ".", cwd: "." };
        if (name === "terraform") return { workspace: w.ws };
        return s.res[name] || {};
      };
      f.funcs = { file: (path) => { if (!(path in w.fs)) throw new Error(`no file exists at "${path}"`); return w.fs[path]; } };
      return f;
    };
    p.V = V;
    const ev = (expr, mp, at, extra) => {
      try { return H.evaluate(expr, { scope: scopeFor(mp, extra), funcs: scopeFor(mp, extra).funcs }); } catch (e) {
        if (!(e instanceof H.EvalError)) throw e;
        diags.push(diag(e.summary, e.detail, { ...at, line: e.line || at.line }));
        return UNKNOWN;
      }
    };
    const callInputs = {};
    const byCfg = {};
    const imports = {};
    for (const im of cfg.root.imports) if (im.to) imports[im.to] = im;
    const removed = {};
    for (const mod of Object.values(cfg.mods)) for (const rm of mod.removed) if (rm.from) removed[(mod.mp ? mod.mp + "." : "") + rm.from] = rm;
    const replaceSet = new Set(opts.replace || []);
    const seen = new Set();
    let pos = 0;
    // -target keeps the named resources and what they depend on; the rest is not evaluated.
    let keep = null;
    if (p.targets.length) {
      keep = new Set();
      const add = (id) => { if (keep.has(id) || !graph.nodes.has(id)) return; keep.add(id); for (const d of graph.nodes.get(id).deps) add(d); };
      for (const t of p.targets) { const tid = t.replace(/\[[^\]]*\]$/, ""); for (const id of graph.nodes.keys()) if (id === tid || id.startsWith(tid + ".")) add(id); }
    }

    for (const n of graph.order) {
      if (keep && !keep.has(n.id)) continue;
      const s = vmod(n.mp);
      const it = n.item;
      pos++;
      // Values that resources read: computed now, and again during apply once
      // the resources they depend on exist.
      const value = () => {
        if (n.kind === "var") {
          if (!n.mp) s.var[it.name] = vars.values[it.name];
          else {
            const given = (callInputs[n.mp] || {})[it.name];
            let x = given !== undefined ? given : it.default !== undefined ? constant(it.default, it.at, diags) : UNKNOWN;
            try { x = convert(x, it.type); } catch (e) { diags.push(diag("Invalid value for input variable", `The given value is not suitable for ${n.mp}.var.${it.name} declared at ${it.at.file}:${it.at.line}: ${e.message}.`, null)); }
            s.var[it.name] = it.sensitive ? new Sens(x) : x;
          }
          for (const val of n.mp ? [] : it.validations) {
            if (!val.cond) continue;
            const ok = unmark(ev(val.cond, n.mp, { file: val.file, line: val.line }));
            if (ok === false) diags.push(diag("Invalid value for variable", `${val.msg}\n\nThis was checked by the validation rule at ${val.file}:${val.line}.`, { file: it.at.file, line: it.at.line }));
          }
          return;
        }
        if (n.kind === "local") { s.local[n.id.split(".").pop()] = ev(it.expr, n.mp, it.at); return; }
        if (n.kind === "call") {
          const child = it.child;
          callInputs[child] = {};
          for (const a of it.inputs) callInputs[child][a.name] = ev(a.expr, n.mp, { ...it.at, line: a.line });
          s.mod[it.name] = s.mod[it.name] || {};
          return;
        }
        if (n.kind === "out") {
          const name = n.id.split(".").pop();
          const thunk = () => ev(it.expr, n.mp, it.at);
          const val = opts.validateOnly ? null : thunk();
          if (n.mp) {
            const parts = n.mp.split(".");
            vmod(parts.slice(0, -2).join(".")).mod[parts[parts.length - 1]][name] = val;
          } else p.outputs[name] = { after: val, sensitive: it.sensitive, thunk };
          if (!it.sensitive && H.deepSens(val)) {
            diags.push(diag("Output refers to sensitive values", "To reduce the risk of accidentally exporting sensitive data that was intended to be only internal, Terraform requires that any root module output containing sensitive data be explicitly marked as sensitive, to confirm your intent.\n\nIf you do intend to export this data, annotate the output value as sensitive by adding the following argument:\n    sensitive = true", { file: it.at.file, line: it.block.line }));
          }
          return;
        }
      };
      if (n.kind !== "res" && n.kind !== "data") {
        value();
        if (n.mp || n.kind === "local" || n.kind === "call") p.refreshers.push({ pos, fn: value });
        continue;
      }
      // Resources and data sources: expand count or for_each, then plan each instance.
      const r = it;
      const attrs = r.block.attrs;
      let keys = [undefined];
      let eachVals = null;
      const at = r.at;
      if (attrs.count) {
        const c = unmark(ev(attrs.count.expr, n.mp, { ...at, line: attrs.count.line }));
        if (c === UNKNOWN) { diags.push(diag("Invalid count argument", 'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.', { ...at, line: attrs.count.line })); continue; }
        if (typeof c !== "number") { diags.push(diag("Invalid count argument", 'The given "count" argument value is unsuitable: a number is required.', { ...at, line: attrs.count.line })); continue; }
        keys = [...Array(Math.max(0, c)).keys()];
        s.res[r.type] = s.res[r.type] || {};
      } else if (attrs.for_each) {
        const raw = ev(attrs.for_each.expr, n.mp, { ...at, line: attrs.for_each.line });
        const fe = unmark(raw);
        const fat = { ...at, line: attrs.for_each.line };
        if (raw instanceof Sens || H.deepSens(raw)) { diags.push(diag("Invalid for_each argument", "Sensitive values, or values derived from sensitive values, cannot be used as for_each arguments. If used, the sensitive value could be exposed as a resource instance key.", fat)); continue; }
        if (fe === UNKNOWN || (Array.isArray(fe) && fe.some(H.deepUnknown))) {
          diags.push(diag("Invalid for_each argument", 'The "for_each" set includes values derived from resource attributes that cannot be determined until apply, and so Terraform cannot determine the full set of keys that will identify the instances of this resource.\n\nWhen working with unknown values in for_each, it\'s better to use a map value where the keys are defined statically in your configuration and where only the values contain apply-time results.\n\nAlternatively, you could use the -target planning option to first apply only the resources that the for_each value depends on, and then apply a second time to fully converge.', fat));
          continue;
        }
        if (Array.isArray(fe) && !fe.tqSet) { diags.push(diag("Invalid for_each argument", 'The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings, and you have provided a value of type tuple.', fat)); continue; }
        if (fe === null || typeof fe !== "object") { diags.push(diag("Invalid for_each argument", `The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings, and you have provided a value of type ${H.typeName(fe)}.`, fat)); continue; }
        eachVals = Array.isArray(fe) ? Object.fromEntries(fe.map((k) => [String(k), k])) : fe;
        keys = Object.keys(eachVals);
        s.res[r.type] = s.res[r.type] || {};
      }
      const holder = r.mode === "data" ? (s.data[r.type] = s.data[r.type] || {}) : (s.res[r.type] = s.res[r.type] || {});
      if (keys.length !== 1 || keys[0] !== undefined) holder[r.name] = attrs.count ? [] : {};
      const S = schemaOf(r);
      for (const key of keys) {
        const addr = keyed(r.id, key);
        seen.add(addr);
        // each.value is read again at apply time, when the values it holds are known.
        const eachOf = (k) => {
          const cur = unmark(ev(attrs.for_each.expr, n.mp, { ...at, line: attrs.for_each.line }));
          return cur && typeof cur === "object" && !Array.isArray(cur) && k in cur ? cur[k] : eachVals[k];
        };
        const extra = attrs.count ? { count: { index: key } } : eachVals ? { each: { key, get value() { return eachOf(key); } } } : null;
        const scope = scopeFor(n.mp, extra);
        const argsOf = () => instanceArgs(r, scope, diags);
        const after = argsOf();
        const slot = (v) => { if (key === undefined) holder[r.name] = v; else holder[r.name][key] = v; };
        const c = { addr, cfgId: r.id, r, mp: n.mp, key, pos, argsOf, slot, after, forced: [], changed: [], region: regionOf(cfg, r) };
        if (r.mode === "data") {
          const deps = [...(n.explicit || []), ...(n.inherited || [])];
          const pending = deps.some((id) => (byCfg[id] || []).some((x) => x.action !== "noop"));
          if (H.deepUnknown(after) || pending) {
            c.action = "read";
            c.reason = pending ? "depends on a resource or a module with changes pending" : "config refers to values not yet known";
            slot(UNKNOWN);
            p.changes.push(c);
          } else {
            try { const v = readData(w, r.type, strip(after)); slot(v); c.value = v; } catch (e) {
              diags.push(diag(e.message, null, { ...r.at, with: addr }));
              slot(UNKNOWN);
            }
          }
          (byCfg[r.id] = byCfg[r.id] || []).push(c);
          continue;
        }
        let base = prior.resources[addr];
        const im = imports[addr];
        if (!base && im && im.id) {
          const o = w.cloudGet(r.type, im.id);
          if (!o) {
            diags.push(diag("Cannot import non-existent remote object", `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`, im.at));
            continue;
          }
          c.importId = im.id;
          base = { attrs: clone(o.attrs), id: o.id };
        }
        c.before = base ? base.attrs : null;
        c.cbd = lcFlag(r, "create_before_destroy");
        if (p.mode === "destroy") { c.action = "noop"; slot(plannedValue(r, after, c.before, !base)); (byCfg[r.id] = byCfg[r.id] || []).push(c); continue; }
        if (!base) c.action = "create";
        else {
          c.changed = changedArgs(S, after, base.attrs, ignored(r));
          c.forced = c.changed.filter((x) => (S.args[x] || "").includes("n"));
          const asked = replaceSet.has(addr);
          if (base.tainted) c.why = "tainted";
          else if (asked) c.why = "requested";
          c.action = base.tainted || asked || c.forced.length ? "replace" : c.changed.length ? "update" : "noop";
          if (c.importId) { c.action = c.action === "noop" ? "import" : c.action === "update" ? "import" : c.action; c.importUpdate = c.changed.length > 0; }
        }
        c.value = plannedValue(r, after, base && base.attrs, c.action === "create" || c.action === "replace");
        slot(c.value);
        p.changes.push(c);
        (byCfg[r.id] = byCfg[r.id] || []).push(c);
      }
    }
    if (diags.some((d) => d.sev === "Error")) return p;
    // State instances the configuration no longer has.
    const order = Object.fromEntries(graph.order.map((x, i) => [x.id, i]));
    for (const [addr, st] of Object.entries(prior.resources)) {
      if (st.mode !== "managed") continue;
      const cfgId = addr.replace(/\[[^\]]*\]$/, "");
      if (seen.has(addr) && p.mode !== "destroy") continue;
      const rm = Object.entries(removed).find(([from]) => addrMatches(addr, from));
      const r = { type: st.type, name: st.name, mode: "managed", id: cfgId };
      const c = { addr, cfgId, r, before: st.attrs, pos: order[cfgId] ?? -1, forced: [], changed: [], action: rm && !rm[1].destroy ? "forget" : "delete" };
      if (p.mode !== "destroy") {
        const idx = /\[(.+)\]$/.exec(addr);
        const inCfg = graph.nodes.get(cfgId);
        const uses = inCfg && (inCfg.item.block.attrs.count ? "count" : inCfg.item.block.attrs.for_each ? "for_each" : null);
        const numeric = idx && /^\d+$/.test(idx[1]);
        c.reason = !inCfg ? `because ${cfgId} is not in configuration`
          : !idx ? "because resource uses count or for_each"
            : !uses ? `because ${cfgId} does not use "count" or "for_each"`
            : numeric && uses === "for_each" ? "because resource does not use count"
              : idx && !numeric && uses === "count" ? "because resource does not use for_each"
                : numeric ? `because index [${idx[1]}] is out of range for count` : `because key [${idx[1]}] is not in for_each map`;
      }
      if (rm && !rm[1].destroy) c.reason = null;
      const cfgNode = graph.nodes.get(cfgId);
      if (cfgNode && p.mode === "destroy") c.r = cfgNode.item;
      p.changes.push(c);
    }
    // -target keeps the named resources and what they depend on.
    if (keep) {
      const exact = p.targets.filter((t) => /\]$/.test(t));
      p.changes = p.changes.filter((c) => (keep.has(c.cfgId) || p.targets.some((t) => addrMatches(c.addr, t))) && (!exact.some((t) => t.replace(/\[[^\]]*\]$/, "") === c.cfgId) || exact.includes(c.addr)));
    }
    // prevent_destroy guards every plan that would delete the object.
    for (const c of p.changes) {
      if ((c.action === "delete" || c.action === "replace") && c.r.block && lcFlag(c.r, "prevent_destroy")) {
        diags.push(diag("Instance cannot be destroyed", `Resource ${c.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target flag.`, { file: c.r.at.file, line: c.r.at.line }));
      }
    }
    if (p.mode === "refresh") p.changes = [];
    // Output changes.
    if (p.mode === "destroy") for (const name of Object.keys(prior.outputs)) p.outputs[name] = { after: null, sensitive: prior.outputs[name].sensitive, thunk: () => null };
    for (const [name, o] of Object.entries(p.outputs)) {
      const was = prior.outputs[name];
      o.before = was ? was.value : undefined;
      o.action = !was ? "create" : same(was.value, o.after) && !H.deepUnknown(o.after) ? "noop" : "update";
      if (o.after === null && p.mode === "destroy") o.action = "delete";
    }
    for (const name of Object.keys(prior.outputs)) if (!(name in p.outputs) && p.mode !== "destroy" && !keep) p.outputs[name] = { before: prior.outputs[name].value, after: null, action: "delete", sensitive: prior.outputs[name].sensitive };
    p.changes.sort((a, b) => a.pos - b.pos || (a.addr < b.addr ? -1 : 1));
    return p;
  }

  // --- showing a plan -------------------------------------------------------------------

  const SYM = { create: "+", update: "~", replace: "-/+", cbd: "+/-", delete: "-", read: "<=", import: "~", forget: "." };
  const cls = (sym) => (sym === "+" ? "add" : sym === "~" ? "chg" : sym === "-" ? "del" : sym === "-/+" || sym === "+/-" ? "del" : null);
  const valText = (v, sens) => (sens || v instanceof Sens ? "(sensitive value)" : H.deepUnknown(v) ? "(known after apply)" : show(strip(v), "        "));

  // Attribute lines of one resource block in a plan, aligned like Terraform's.
  function attrLines(c, ind) {
    const S = schemaOf(c.r) || { args: {}, blocks: {} };
    const sensArg = (n) => (S.args[n] || "").includes("s");
    const rows = [];
    const blocks = [];
    let hidden = 0;
    let hiddenBlocks = 0;
    const isBlock = (n) => (S.blocks || {})[n];
    const before = c.before || {};
    const after = c.action === "delete" || c.action === "forget" ? {} : c.value || {};
    const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const n of names) {
      const a = after[n];
      const b = before[n];
      const empty = (x) => norm(x, n) === null && x !== UNKNOWN;
      if (isBlock(n)) {
        const A = (a && a !== UNKNOWN ? a : []).map((x) => JSON.stringify(norm(x)));
        const B = (b || []).map((x) => JSON.stringify(norm(x)));
        if (c.action === "create") (a || []).forEach((x) => blocks.push(["+", n, x]));
        else if (c.action === "delete") (b || []).forEach((x) => blocks.push(["-", n, x]));
        else {
          (b || []).forEach((x, i) => { if (!A.includes(B[i])) blocks.push(["-", n, x]); else hiddenBlocks++; });
          (a || []).forEach((x, i) => { if (!B.includes(A[i])) blocks.push(["+", n, x]); });
        }
        continue;
      }
      // Maps show one line per key, each with the block's own symbol.
      const mapText = (sym, m, tail) => (m && typeof m === "object" && !Array.isArray(m) && m !== UNKNOWN && !(m instanceof Sens)
        ? ["{", ...Object.keys(m).sort().map((k) => `${ind}      ${sym} ${JSON.stringify(k)} = ${valText(m[k])}${tail}`), `${ind}    }${sym === "-" ? " -> null" : ""}`].join("\n") : null);
      if (c.action === "create") { if (!empty(a)) rows.push(["+", n, mapText("+", strip(a), "") || valText(a, sensArg(n))]); continue; }
      if (c.action === "delete" || c.action === "forget") { if (!empty(b)) rows.push([c.action === "forget" ? " " : "-", n, (c.action === "delete" ? mapText("-", b, "") : null) || `${valText(b, sensArg(n))}${c.action === "delete" ? " -> null" : ""}`]); continue; }
      const changed = c.changed.includes(n) || ((c.action === "replace") && a === UNKNOWN && !empty(b));
      if (!changed) {
        if (n === "id" || n === "name" || n === "bucket" || n === "identifier" || n === "tags") { if (!empty(b)) rows.push([" ", n, mapText(" ", b, "") || valText(b, sensArg(n))]); } else if (!empty(b)) hidden++;
        continue;
      }
      const force = c.forced.includes(n) ? " # forces replacement" : "";
      if (empty(b)) rows.push(["+", n, valText(a, sensArg(n)) + force]);
      else if (empty(a)) rows.push(["-", n, `${valText(b, sensArg(n))} -> null${force}`]);
      else if (n === "tags" && a && b && a !== UNKNOWN) {
        const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
        const inner = [];
        let same0 = 0;
        for (const k of keys) {
          if (!(k in b)) inner.push(["+", JSON.stringify(k), JSON.stringify(strip(a[k]))]);
          else if (!(k in a)) inner.push(["-", JSON.stringify(k), `${JSON.stringify(b[k])} -> null`]);
          else if (strip(a[k]) !== b[k]) inner.push(["~", JSON.stringify(k), `${JSON.stringify(b[k])} -> ${JSON.stringify(strip(a[k]))}`]);
          else same0++;
        }
        const w = Math.max(...inner.map((x) => x[1].length));
        rows.push(["~", n, ["{", ...inner.map(([s, k, v]) => `${ind}      ${s} ${k.padEnd(w)} = ${v}`), ...(same0 ? [`${ind}        # (${same0} unchanged element${same0 === 1 ? "" : "s"} hidden)`] : []), `${ind}    }`].join("\n")]);
      } else rows.push(["~", n, `${valText(b, sensArg(n))} -> ${valText(a, sensArg(n))}${force}`]);
    }
    const w = Math.max(0, ...rows.map((r) => r[1].length));
    const lines = rows.map(([s, n, v]) => `${ind}  ${s === " " ? "  " : s + " "}${n.padEnd(w)} = ${v}`.replace(/\n/g, "\n"));
    if (hidden) lines.push(`${ind}    # (${hidden} unchanged attribute${hidden === 1 ? "" : "s"} hidden)`);
    for (const [s, n, x] of blocks) {
      lines.push(`${ind}  ${s} ${n} {`);
      const keys = Object.keys(x).filter((k) => norm(x[k], k) !== null).sort();
      const bw = Math.max(0, ...keys.map((k) => k.length));
      for (const k of keys) lines.push(`${ind}      ${s} ${k.padEnd(bw)} = ${valText(x[k])}${s === "-" ? " -> null" : ""}`);
      lines.push(`${ind}    }`);
    }
    if (hiddenBlocks) lines.push(`${ind}    # (${hiddenBlocks} unchanged block${hiddenBlocks === 1 ? "" : "s"} hidden)`);
    return lines.join("\n").split("\n");
  }

  function resourceBlock(c, sym, header) {
    const r = c.r;
    const kw = r.mode === "data" ? "data" : "resource";
    const lead = sym.length === 3 ? sym : sym === "<=" ? " <=" : sym === "." ? " ." : `  ${sym}`;
    const out = [...header.map((t) => [t, null]), [`${lead} ${kw} "${r.type}" "${r.name}" {`, cls(sym)]];
    for (const l of attrLines(c, "    ")) out.push([l, cls(l.trim()[0] === "#" ? null : l.trim().split(" ")[0])]);
    out.push(["    }", null], ["", null]);
    return out;
  }

  function driftLines(p) {
    const items = p.mode === "refresh" ? p.drift : p.drift.filter((d) => p.changes.some((c) => c.addr === d.addr && c.action !== "noop") || !d.after);
    if (!items.length) return [];
    const out = [["", null], ["Note: Objects have changed outside of Terraform", "note"], ["", null], ["Terraform detected the following changes made outside of Terraform since the", null], ['last "terraform apply" which may have affected this plan:', null], ["", null]];
    for (const d of items) {
      const S = RESOURCES[d.r.type];
      const changed = d.after ? Object.keys(S.args).concat(Object.keys(S.blocks || {})).filter((n) => !same(d.before[n] ?? null, d.after[n] ?? null, n)) : [];
      out.push(...resourceBlock({ r: d.r, before: d.before, value: d.after, changed, forced: [], action: d.after ? "update" : "delete" }, d.after ? "~" : "-", [`  # ${d.addr} ${d.after ? "has changed" : "has been deleted"}`]));
    }
    out.push(["", null]);
    if (p.mode === "refresh") out.push(["This is a refresh-only plan, so Terraform will not take any actions to undo", null], ["these. If you were expecting these changes then you can apply this plan to", null], ["record the updated values in the Terraform state without changing any remote", null], ["objects.", null]);
    else out.push(["Unless you have made equivalent changes to your configuration, or ignored the", null], ["relevant attributes using ignore_changes, the following plan may include", null], ["actions to undo or respond to these changes.", null]);
    out.push(["", null], ["─".repeat(77), "dim"]);
    return out;
  }

  function counts(p) {
    const n = { import: 0, add: 0, change: 0, destroy: 0 };
    for (const c of p.changes) {
      if (c.action === "create") n.add++;
      if (c.action === "update") n.change++;
      if (c.action === "replace") { n.add++; n.destroy++; }
      if (c.action === "delete") n.destroy++;
      if (c.action === "import") { n.import++; if (c.importUpdate) n.change++; }
    }
    return n;
  }

  function renderPlan(w, p) {
    const out = driftLines(p);
    const acts = p.changes.filter((c) => c.action !== "noop");
    const outs = Object.entries(p.outputs).filter(([, o]) => o.action !== "noop");
    if (p.mode === "refresh") {
      if (!p.drift.length) out.push(["", null], ["No changes. Your infrastructure still matches the configuration.", "ok"], ["", null], ["Terraform has checked that the real remote objects still match the result of", null], ["your most recent changes, and found no differences.", null]);
      return out;
    }
    if (!acts.length && !outs.length && !p.moves.length) {
      out.push(["", null], ["No changes. Your infrastructure matches the configuration.", "ok"], ["", null],
        ["Terraform has compared your real infrastructure against your configuration", null], ["and found no differences, so no changes are needed.", null]);
      return out;
    }
    const kinds = new Set(acts.map((c) => (c.action === "replace" ? (c.cbd ? "cbd" : "replace") : c.action)));
    if (acts.length) {
      out.push(["", null], ["Terraform used the selected providers to generate the following execution", null], ["plan. Resource actions are indicated with the following symbols:", null]);
      const legend = [["create", "  + create"], ["update", "  ~ update in-place"], ["import", "  ~ update in-place"], ["delete", "  - destroy"], ["replace", "-/+ destroy and then create replacement"], ["cbd", "+/- create replacement and then destroy"], ["read", " <= read (data resources)"]];
      const shown = new Set();
      for (const [k, t] of legend) if (kinds.has(k) && !shown.has(t)) { shown.add(t); out.push([t, cls(SYM[k])]); }
      out.push(["", null], ["Terraform will perform the following actions:", null], ["", null]);
    }
    for (const c of p.changes) {
      const mv = p.moves.find((m) => m.to === c.addr);
      if (c.action === "noop" && !mv) continue;
      if (c.action === "noop") { out.push(...resourceBlock({ ...c, action: "update", changed: [] }, " ", [`  # ${mv.from} has moved to ${c.addr}`])); continue; }
      const head = [];
      if (c.action === "create") head.push(`  # ${c.addr} will be created`);
      if (c.action === "update") head.push(`  # ${c.addr} will be updated in-place`);
      if (c.action === "import") head.push(c.importUpdate ? `  # ${c.addr} will be updated in-place` : `  # ${c.addr} will be imported`, `    # (imported from "${c.importId}")`);
      if (c.action === "replace") head.push(c.why === "tainted" ? `  # ${c.addr} is tainted, so must be replaced` : c.why === "requested" ? `  # ${c.addr} will be replaced, as requested` : `  # ${c.addr} must be replaced`);
      if (c.action === "delete") head.push(`  # ${c.addr} will be destroyed`, ...(c.reason ? [`  # (${c.reason})`] : []));
      if (c.action === "forget") head.push(`  # ${c.addr} will no longer be managed by Terraform`);
      if (c.action === "read") head.push(`  # ${c.addr} will be read during apply`, `  # (${c.reason})`);
      if (mv) head.unshift(`  # (moved from ${mv.from})`);
      const sym = c.action === "replace" ? (c.cbd ? "+/-" : "-/+") : c.action === "forget" ? "." : SYM[c.action];
      if (c.action === "read") { out.push(...resourceBlock({ ...c, action: "create", before: null, value: { id: UNKNOWN, ...c.after } }, "<=", head)); continue; }
      out.push(...resourceBlock(c.action === "forget" ? { ...c, value: c.before, action: "update", changed: [] } : c, sym, head));
    }
    const n = counts(p);
    const forgets = acts.filter((c) => c.action === "forget").map((c) => c.addr);
    if (acts.length || p.moves.length) {
      const forget = acts.filter((c) => c.action === "forget").length;
      out.push([`Plan: ${n.import ? `${n.import} to import, ` : ""}${n.add} to add, ${n.change} to change, ${n.destroy} to destroy${forget ? `, ${forget} to forget` : ""}.`, "plan"]);
    }
    if (outs.length) {
      out.push(["", null], [acts.length ? "Changes to Outputs:" : "Changes to Outputs:", null]);
      const wd = Math.max(...outs.map(([k]) => k.length));
      for (const [k, o] of outs) {
        const sym = o.action === "create" ? "+" : o.action === "delete" ? "-" : "~";
        const v = (x) => (o.sensitive ? "(sensitive value)" : valText(x));
        out.push([`  ${sym} ${k.padEnd(wd)} = ${o.action === "create" ? v(o.after) : o.action === "delete" ? `${v(o.before)} -> null` : `${v(o.before)} -> ${v(o.after)}`}`, cls(sym)]);
      }
      if (!acts.length) out.push(["", null], ["You can apply this plan to save these new output values to the Terraform", null], ["state, without changing any real infrastructure.", null]);
    }
    if (forgets.length) out.push(["", null], ...renderDiag(w, diag("Some objects will no longer be managed by Terraform", `If you apply this plan, Terraform will discard its tracking information for the following objects, but it will not delete them:\n${forgets.map((a) => ` - ${a}`).join("\n")}\n\nAfter applying this plan, Terraform will no longer manage these objects. You will need to import them into Terraform to manage them again.`, null, "Warning")));
    return out;
  }

  // --- applying -----------------------------------------------------------------------

  const DURATION = { aws_db_instance: "5m42s", aws_instance: "13s", aws_cloudfront_distribution: "3m21s", aws_autoscaling_group: "48s", aws_security_group: "2s" };
  const took = (type) => DURATION[type] || "1s";

  function apiDiag(e, c) {
    if (!e.op && !e.plain) throw e;
    return diag(e.plain ? e.message : `${e.op} ${e.what}: ${e.short}`, null, c && c.r.at ? { ...c.r.at, with: c.addr } : null);
  }

  function applyPlan(w, p) {
    const out = [];
    const say = (t, k) => out.push([t, k || null]);
    const st = p.prior;
    const done = { imported: 0, added: 0, changed: 0, destroyed: 0 };
    const record = (c, obj) => {
      st.resources[c.addr] = { addr: c.addr, mode: "managed", type: c.r.type, name: c.r.name, mp: c.mp, key: c.key, id: obj.id, attrs: clone(obj.attrs) };
      if (c.slot) c.slot({ ...plannedValue(c.r, {}, obj.attrs, false), ...obj.attrs });
    };
    const destroy = (c, id, deposed) => {
      const label = deposed ? `${c.addr} (deposed object ${w.hex(8)})` : c.addr;
      say(`${label}: Destroying... [id=${id}]`);
      cloudDelete(w, c.r.type, id);
      say(`${label}: Destruction complete after ${took(c.r.type)}`);
      done.destroyed++;
    };
    const create = (c, args) => {
      say(`${c.addr}: Creating...`);
      const obj = cloudCreate(w, c.r.type, args, c.region);
      record(c, obj);
      say(`${c.addr}: Creation complete after ${took(c.r.type)} [id=${obj.id}]`);
      done.added++;
    };
    const later = [];
    let failed = null;
    if (p.changes.some((c) => c.action !== "noop")) say("");
    let current = null;
    try {
      for (const c of p.changes) {
        current = c;
        for (const r of p.refreshers || []) if (r.pos < c.pos) r.fn();
        if (c.action === "noop" || c.action === "delete") continue;
        if (c.action === "forget") { delete st.resources[c.addr]; continue; }
        if (c.action === "read") {
          say(`${c.addr}: Reading...`);
          const v = readData(w, c.r.type, strip(c.argsOf()));
          c.slot(v);
          st.resources[c.addr] = { addr: c.addr, mode: "data", type: c.r.type, name: c.r.name, mp: c.mp, key: c.key, id: v.id, attrs: v };
          say(`${c.addr}: Read complete after 0s [id=${v.id}]`);
          continue;
        }
        const args = strip(c.argsOf());
        if (c.action === "create") create(c, args);
        else if (c.action === "update" || (c.action === "import" && c.importUpdate)) {
          if (c.action === "import") { say(`${c.addr}: Importing... [id=${c.importId}]`); say(`${c.addr}: Import complete [id=${c.importId}]`); done.imported++; }
          const id = c.importId || st.resources[c.addr].id;
          say(`${c.addr}: Modifying... [id=${id}]`);
          cloudUpdate(w, c.r.type, id, args);
          record(c, w.cloudGet(c.r.type, id));
          say(`${c.addr}: Modifications complete after ${took(c.r.type)} [id=${id}]`);
          done.changed++;
        } else if (c.action === "import") {
          say(`${c.addr}: Importing... [id=${c.importId}]`);
          record(c, w.cloudGet(c.r.type, c.importId));
          say(`${c.addr}: Import complete [id=${c.importId}]`);
          done.imported++;
        } else if (c.action === "replace") {
          const old = st.resources[c.addr];
          if (c.cbd) { create(c, args); later.push([c, old.id]); } else {
            destroy(c, old.id);
            delete st.resources[c.addr];
            create(c, args);
          }
        }
      }
      for (const c of [...p.changes].reverse()) {
        current = c;
        if (c.action !== "delete") continue;
        destroy(c, c.before.id);
        delete st.resources[c.addr];
      }
      for (const [c, id] of later) { current = c; destroy(c, id, true); }
    } catch (e) { failed = apiDiag(e, current); }
    if (!failed) {
      for (const r of p.refreshers || []) r.fn();
      for (const [name, o] of Object.entries(p.outputs)) {
        if (o.action === "delete" || p.mode === "destroy") { delete st.outputs[name]; continue; }
        const v = o.thunk ? o.thunk() : o.after;
        st.outputs[name] = { value: strip(v), sensitive: o.sensitive || H.deepSens(v) };
      }
    }
    st.serial++;
    st.tfv = w.cli;
    w.state = st;
    w.applied.push({ ws: w.ws, store: w.storeKey(), changes: p.changes.filter((c) => c.action !== "noop").map((c) => ({ addr: c.addr, action: c.action })) });
    if (failed) {
      out.push(...renderDiag(w, failed));
      w.status = 1;
      return out;
    }
    say("");
    if (p.mode === "destroy") say(`Destroy complete! Resources: ${done.destroyed} destroyed.`, "ok");
    else say(`Apply complete! Resources: ${done.imported ? `${done.imported} imported, ` : ""}${done.added} added, ${done.changed} changed, ${done.destroyed} destroyed.`, "ok");
    out.push(...outputsBlock(w, st));
    return out;
  }

  function outputsBlock(w, st) {
    const names = Object.keys(st.outputs).sort();
    if (!names.length) return [];
    return [["", null], ["Outputs:", null], ["", null], ...names.map((k) => [`${k} = ${st.outputs[k].sensitive ? "<sensitive>" : show(st.outputs[k].value)}`, null])];
  }

  // --- the lock file and init -------------------------------------------------------------

  const REG = (name) => `registry.terraform.io/hashicorp/${name}`;
  function readLock(w) {
    const out = {};
    if (!w.fs[".terraform.lock.hcl"]) return out;
    let body;
    try { body = H.parse(w.fs[".terraform.lock.hcl"]); } catch { return out; }
    for (const b of body.blocks) {
      if (b.type !== "provider") continue;
      const get = (n) => (b.attrs[n] ? strip(H.evaluate(b.attrs[n].expr, { scope: () => null })) : null);
      out[b.labels[0].split("/").pop()] = { version: get("version"), constraints: get("constraints"), hashes: get("hashes") || [] };
    }
    return out;
  }
  function writeLock(w, lock) {
    const parts = ['# This file is maintained automatically by "terraform init".', "# Manual edits may be lost in future updates.", ""];
    for (const name of Object.keys(lock).sort()) {
      const l = lock[name];
      parts.push(`provider "${REG(name)}" {`, `  version     = "${l.version}"`, ...(l.constraints ? [`  constraints = "${l.constraints}"`] : []), "  hashes = [", ...l.hashes.map((x) => `    "${x}",`), "  ]", "}", "");
    }
    w.fs[".terraform.lock.hcl"] = parts.join("\n");
  }
  const hashFor = (platform, version) => `h1:${platform}-${version}-practice=`;
  const hasHash = (l, platform) => l.hashes.some((x) => x.startsWith("zh:") || x === hashFor(platform, l.version));

  const BACKEND_ARGS = { s3: ["bucket", "key", "region", "dynamodb_table", "use_lockfile", "encrypt", "profile", "kms_key_id", "workspace_key_prefix"], local: ["path"] };
  const backendSig = (be) => (be ? JSON.stringify([be.type, be.cfg]) : JSON.stringify(["local", {}]));
  const locking = (be) => Boolean(be && be.type === "s3" && (be.cfg.dynamodb_table || be.cfg.use_lockfile));

  const INIT_DONE = ["", "Terraform has been successfully initialized!", "", 'You may now begin working with Terraform. Try running "terraform plan" to see', "any changes that are required for your infrastructure. All Terraform commands", "should now work.", "", "If you ever set or change modules or backend configuration for Terraform,", "rerun this command to reinitialize your working directory. If you forget, other", "commands will detect it and remind you to do so if necessary."];

  function coreVersionDiags(w, cfg) {
    const diags = [];
    for (const mod of Object.values(cfg.mods)) for (const rv of mod.reqVersion) {
      if (rv.value && !satisfies(w.cli, rv.value)) diags.push(diag("Unsupported Terraform Core version", `This configuration does not support Terraform version ${w.cli}. To proceed, either choose another supported Terraform version or update this version constraint. Version constraints are normally set for good reason, so updating the constraint may lead to other errors or unexpected behavior.`, rv.at));
    }
    return diags;
  }

  function init(w, flags, answer) {
    const out = [];
    const say = (t, k) => out.push([t, k || null]);
    const fail = (d) => { out.push(...renderDiag(w, d)); w.status = 1; return out; };
    const root = readModule(w, "", "", []);
    const pre = loadConfig(w);
    const syntax = pre.diags.filter((d) => !/^Module (not installed|source has changed|version requirements)/.test(d.summary));
    const core = coreVersionDiags(w, pre);
    if (core.length || syntax.length) { for (const d of [...core, ...syntax]) out.push(...renderDiag(w, d)); w.status = 1; return out; }
    const dot = w.dot ? clone(w.dot) : { backend: null, providers: {}, modules: {} };
    // Modules first, as Terraform does.
    const upgrade = flags.has("-upgrade");
    if (Object.values(pre.mods).some((m) => m.calls.length) || root.calls.length) {
      say(upgrade ? "Upgrading modules..." : "Initializing modules...");
      const install = (dir, mp) => {
        const mod = readModule(w, dir, mp, []);
        for (const call of mod.calls) {
          const key = mp ? `${mp}.${call.name}` : call.name;
          const childMp = `${mp ? mp + "." : ""}module.${call.name}`;
          const src = String(call.source || "");
          if (/^\.\.?\//.test(src)) {
            const parts = [...(dir ? dir.split("/") : []), ...src.split("/")].filter((x) => x && x !== ".");
            const norm0 = [];
            for (const x of parts) { if (x === "..") norm0.pop(); else norm0.push(x); }
            const cdir = norm0.join("/");
            if (!tfFiles(w, cdir).length) return fail(diag("Unreadable module directory", `The directory ${cdir} does not exist or cannot be read.`, call.at));
            dot.modules[key] = { source: src, dir: cdir };
            say(`- ${key} in ${cdir}`);
            if (install(cdir, childMp)) return true;
            continue;
          }
          const reg = (w.scenario.registry || {})[src];
          if (!reg) return fail(diag("Module not found", `The module address "${src}" could not be resolved.\n\nIf you intended this as a path relative to the current module, use "./${src}" instead. The "./" prefix indicates that the address is a relative filesystem path.`, call.at));
          const have = dot.modules[key];
          let version = have && have.source === src && !upgrade && (!call.version || satisfies(have.version, call.version)) ? have.version : null;
          if (!version) {
            version = Object.keys(reg).sort(vcmp).reverse().find((v) => satisfies(v, call.version));
            if (!version) return fail(diag("Unresolvable module version constraint", `There is no available version of module "${key}" (${src}) which matches the given version constraint. Try another constraint or check that the module source address is correct.`, call.at));
            say(`Downloading registry.terraform.io/${src} ${version} for ${key}...`);
            for (const f of Object.keys(w.fs)) if (f.startsWith(`.terraform/modules/${key}/`)) delete w.fs[f];
            for (const [f, text] of Object.entries(reg[version])) w.fs[`.terraform/modules/${key}/${f}`] = text;
          }
          dot.modules[key] = { source: src, version, dir: `.terraform/modules/${key}` };
          say(`- ${key} in .terraform/modules/${key}`);
          if (install(`.terraform/modules/${key}`, childMp)) return true;
        }
        return false;
      };
      if (install("", "")) return out;
    }
    // The backend.
    if (!answer) say("Initializing the backend...");
    const be = root.backend && !flags.has("-backend=false") ? root.backend : null;
    if (be && be.type !== "s3" && be.type !== "local") return fail(diag("Unsupported backend type", `There is no backend type named "${be.type}".`, { file: be.file, line: be.line }));
    if (be) {
      const allowed = BACKEND_ARGS[be.type];
      for (const k of Object.keys(be.cfg)) {
        if (!allowed.includes(k) || (k === "use_lockfile" && vcmp(w.cli, "1.10.0") < 0)) return fail(diag("Unsupported argument", `An argument named "${k}" is not expected here.`, { file: be.file, line: be.line, ctx: `terraform` }));
      }
      if (be.type === "s3" && !w.cloudGet("aws_s3_bucket", be.cfg.bucket)) return fail(diag("Failed to get existing workspaces", `S3 bucket "${be.cfg.bucket}" does not exist.\n\nThe referenced S3 bucket must have been previously created. If the S3 bucket was created within the last minute, please wait for a minute or two and try again.`));
    }
    if (!flags.has("-backend=false")) {
      const prev = dot.backend;
      const was = backendSig(prev);
      const now = backendSig(be);
      if (was !== now) {
        const reconf = flags.has("-reconfigure");
        const migrate = flags.has("-migrate-state");
        if (prev && prev.type === "s3" && be && be.type === "s3" && !reconf && !migrate) {
          return fail(diag("Backend configuration changed", 'A change in the backend configuration has been detected, which may require migrating existing state.\n\nIf you wish to attempt automatic migration of the state, use "terraform init -migrate-state".\nIf you wish to store the current configuration with no changes to the state, use "terraform init -reconfigure".'));
        }
        const fromKey = w.storeKey();
        const fromStates = w.stores[fromKey] || {};
        const hasOld = Object.values(fromStates).some((s) => s && Object.keys(s.resources).length);
        const toKey = be && be.type === "s3" ? `s3://${be.cfg.bucket}/${be.cfg.key}` : "local";
        const toHas = Object.values(w.stores[toKey] || {}).some((s) => s && Object.keys(s.resources).length);
        if (!reconf && hasOld && fromKey !== toKey) {
          if (!answer) {
            const from = prev ? prev.type : "local";
            const to = be ? be.type : "local";
            for (const l of ["Do you want to copy existing state to the new backend?", `  Pre-existing state was found while migrating the previous "${from}" backend to the`, `  newly configured "${to}" backend. ${toHas ? "An existing non-empty state already exists in" : "No existing state was found in the newly"}`, `  ${toHas ? `the new backend. The two states have been saved to temporary files that will be` : `configured "${to}" backend. Do you want to copy this state to the new "${to}"`}`, `  ${toHas ? "removed after responding to this query." : 'backend? Enter "yes" to copy and "no" to start with an empty state.'}`, "", "  Enter a value: "]) say(l, "prompt");
            w.pending = { cmd: "init", resume: (ans) => init(w, flags, ans) };
            return out;
          }
          if (answer === "yes") {
            w.stores[toKey] = clone(fromStates);
            if (fromKey === "local") w.stores.local = { default: null };
          }
        }
        dot.backend = be ? { type: be.type, cfg: be.cfg } : null;
        if (be) { say(""); say(`Successfully configured the backend "${be.type}"! Terraform will automatically`); say("use this backend unless the backend configuration changes."); }
        if (!be && prev) { say(""); say("Terraform has been successfully unconfigured from the remote backend."); }
      }
    }
    // Providers.
    say("Initializing provider plugins...");
    const cfg = loadConfig(Object.assign(Object.create(Object.getPrototypeOf(w)), w, { dot }));
    const lock = readLock(w);
    const before = JSON.stringify(lock);
    const created = !w.fs[".terraform.lock.hcl"];
    for (const req of requirements(cfg)) {
      const reg = PROVIDERS[req.name];
      const cons = req.constraints.map((c) => c.value);
      const consText = cons.join(", ");
      if (!reg) return fail(diag("Failed to query available provider packages", `Could not retrieve the list of available versions for provider ${req.source}: provider registry registry.terraform.io does not have a provider named registry.terraform.io/${req.source}`));
      for (const c of cons) if (!validConstraint(c)) return fail(diag("Invalid version constraint", `This string does not use correct version constraint syntax.`));
      const l = lock[req.name];
      let version;
      if (l && !upgrade) {
        if (!cons.every((c) => satisfies(l.version, c))) return fail(diag("Failed to query available provider packages", `Could not retrieve the list of available versions for provider ${req.source}: locked provider ${REG(req.name)} ${l.version} does not match configured version constraint ${consText}; must use terraform init -upgrade to allow selection of new versions`));
        say(`- Reusing previous version of ${req.source} from the dependency lock file`);
        version = l.version;
      } else {
        say(cons.length ? `- Finding ${req.source} versions matching "${consText}"...` : `- Finding latest version of ${req.source}...`);
        version = [...reg.versions].sort(vcmp).reverse().find((v) => cons.every((c) => satisfies(v, c)));
        if (!version) return fail(diag("Failed to query available provider packages", `Could not retrieve the list of available versions for provider ${req.source}: no available releases match the given constraints ${consText}`));
      }
      if (l && l.version === version && !hasHash(l, w.platform)) {
        if (w.mirror) return fail(diag("Failed to install provider", `Error while installing ${req.source} v${version}: the current package for ${REG(req.name)} ${version} doesn't match any of the checksums previously recorded in the dependency lock file; for more information: https://developer.hashicorp.com/terraform/language/files/dependency-lock#checksum-verification`));
      }
      if (dot.providers[req.name] === version && !upgrade) say(`- Using previously-installed ${req.source} v${version}`);
      else { say(`- Installing ${req.source} v${version}...`); say(`- Installed ${req.source} v${version} (signed by HashiCorp)`); }
      dot.providers[req.name] = version;
      const hashes = l && l.version === version ? [...l.hashes] : [];
      if (!hashes.includes(hashFor(w.platform, version))) hashes.unshift(hashFor(w.platform, version));
      if (!w.mirror && !hashes.some((x) => x.startsWith("zh:"))) hashes.push("zh:all-platforms-practice");
      lock[req.name] = { version, constraints: consText || null, hashes: hashes.sort() };
    }
    if (JSON.stringify(lock) !== before) {
      writeLock(w, lock);
      say("");
      if (created) for (const t of ["Terraform has created a lock file .terraform.lock.hcl to record the provider", "selections it made above. Include this file in your version control repository", "so that Terraform can guarantee to make the same selections by default when", 'you run "terraform init" in the future.']) say(t);
      else for (const t of ["Terraform has made some changes to the provider dependency selections recorded", "in the .terraform.lock.hcl file. Review those changes and commit them to your", "version control system if they represent changes you intended to make."]) say(t);
    }
    w.dot = dot;
    for (const t of INIT_DONE) say(t, t.startsWith("Terraform has been") ? "ok" : null);
    w.status = 0;
    return out;
  }

  // --- before a command touches state ------------------------------------------------------

  // Checks Terraform makes before planning, in its order. Returns { cfg, graph }
  // or { lines } with the errors to print.
  function prepare(w, what) {
    const cfg = loadConfig(w);
    const errs = [...coreVersionDiags(w, cfg)];
    const early = cfg.diags.filter((d) => !/^Module /.test(d.summary));
    if (errs.length || early.length) return { diags: [...errs, ...early] };
    const be = cfg.root.backend;
    const dotBe = w.dot ? w.dot.backend : null;
    if (what !== "validate" && backendSig(be) !== backendSig(dotBe) && !(w.dot && w.dot.noBackend)) {
      const reason = !dotBe ? `Initial configuration of the requested backend "${be.type}"` : !be ? `Unsetting the previously set backend "${dotBe.type}"` : "Backend configuration block has changed";
      return { diags: [diag('Backend initialization required, please run "terraform init"', `Reason: ${reason}\n\nThe "backend" is the interface that Terraform uses to store state, perform operations, etc. If this message is showing up, it means that the Terraform configuration you're using is using a custom configuration for the Terraform backend.\n\nChanges to backend configurations require reinitialization. This allows Terraform to set up the new configuration, copy existing state, etc. Please run "terraform init" with either the "-reconfigure" or "-migrate-state" flags to use the current configuration.\n\nIf the change reason above is incorrect, please verify your configuration hasn't changed and try again. At this point, no changes to your existing configuration or state have been performed.`)] };
    }
    if (cfg.diags.length) return { diags: cfg.diags };
    const lock = readLock(w);
    const reqs = requirements(cfg);
    if (what === "validate" && (!w.dot || reqs.some((r) => !w.dot.providers[r.name]))) {
      const r = reqs.find((x) => !w.dot || !w.dot.providers[x.name]);
      return { diags: [diag("Missing required provider", `This configuration requires provider ${REG(r.name)}, but that provider isn't available. You may be able to install it automatically by running:\n  terraform init`)] };
    }
    const missing = reqs.filter((r) => !lock[r.name]);
    if (missing.length) {
      return { diags: [diag("Inconsistent dependency lock file", `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n${missing.map((r) => `  - provider ${REG(r.name)}: required by this configuration but no version is selected`).join("\n")}\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init`)] };
    }
    const mismatch = reqs.filter((r) => r.constraints.some((c) => !satisfies(lock[r.name].version, c.value)));
    if (mismatch.length) {
      return { diags: [diag("Inconsistent dependency lock file", `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n${mismatch.map((r) => `  - provider ${REG(r.name)}: locked version selection ${lock[r.name].version} doesn't match the updated version constraints "${r.constraints.map((c) => c.value).join(", ")}"`).join("\n")}\n\nTo update the locked dependency selections to match a changed configuration, run:\n  terraform init -upgrade`)] };
    }
    const absent = reqs.filter((r) => !w.dot || w.dot.providers[r.name] !== lock[r.name].version);
    if (absent.length) {
      return { diags: [diag("Required plugins are not installed", `The installed provider plugins are not consistent with the packages selected in the dependency lock file:\n${absent.map((r) => `  - ${REG(r.name)}: there is no package for ${REG(r.name)} ${lock[r.name].version} cached in .terraform/providers`).join("\n")}\n\nTerraform uses external plugins to integrate with a variety of different infrastructure services. To download the plugins required for this configuration, run:\n  terraform init`)] };
    }
    const sc = staticCheck(w, cfg);
    if (sc.diags.some((d) => d.sev === "Error")) return { diags: sc.diags };
    if (what === "validate") return { cfg, graph: sc.graph, diags: sc.diags };
    // Credentials: the provider needs them before it can read anything.
    const prov = cfg.root.providers.find((x) => x.name === "aws");
    if (reqs.some((r) => r.name === "aws") && !w.env.AWS_PROFILE && !w.env.AWS_ACCESS_KEY_ID && !(prov && prov.block.attrs.access_key)) {
      return { diags: [diag("No valid credential sources found", "Please see https://registry.terraform.io/providers/hashicorp/aws\nfor more information about providing credentials.\n\nError: failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: GetMetadata, request canceled, context deadline exceeded", prov ? { file: prov.file, line: prov.block.line, ctx: 'provider "aws"', with: `provider["${REG("aws")}"]` } : null)] };
    }
    const st = w.states()[w.ws];
    if (st && vcmp(st.tfv, w.cli) > 0) {
      return { diags: [diag(`Error loading state: state snapshot was created by Terraform v${st.tfv}, which is newer than current v${w.cli}; upgrade to Terraform v${st.tfv} or greater to work with this state`, null)] };
    }
    return { cfg, graph: sc.graph, diags: sc.diags };
  }

  // The state lock, held for the length of a command.
  function lockError(w) {
    const l = w.locks[w.storeKey()];
    if (!l) return null;
    return diag("Error acquiring the state lock", `Error message: ConditionalCheckFailedException: The conditional request failed\nLock Info:\n  ID:        ${l.id}\n  Path:      ${l.path}\n  Operation: ${l.op}\n  Who:       ${l.who}\n  Version:   ${l.version}\n  Created:   ${l.created}\n  Info:      \n\n\nTerraform acquires a state lock to protect the state from being written by multiple users at the same time. Please resolve the issue above and try again. For most commands, you can disable locking with the "-lock=false" flag, but this is not recommended.`);
  }
  function holdsLock(w) { return locking(w.dot && w.dot.backend); }

  // --- terraform ------------------------------------------------------------------------

  // Split flags (-x, -x=y, --x) from positional words; -var and -var-file
  // keep their order because later ones win.
  function parseArgs(words) {
    const flags = new Map();
    const pos = [];
    const vars = [];
    const multi = { target: [], replace: [], platform: [] };
    const takes = new Set(["var", "var-file", "target", "replace", "out", "state", "lock-timeout", "chdir", "platform", "backend-config"]);
    for (let i = 0; i < words.length; i++) {
      const m = /^--?([\w-]+)(?:=([\s\S]*))?$/.exec(words[i]);
      if (!m || words[i] === "-") { pos.push(words[i]); continue; }
      let [, k, v] = m;
      if (v === undefined && takes.has(k) && i + 1 < words.length) v = words[++i];
      if (k === "var") { const eq = String(v || "").indexOf("="); vars.push(eq > 0 ? { name: v.slice(0, eq), value: v.slice(eq + 1) } : { bad: v || "" }); continue; }
      if (k === "var-file") { vars.push({ file: v || "" }); continue; }
      if (k in multi) { multi[k].push(v || ""); continue; }
      flags.set(k, v === undefined ? true : v);
    }
    const has = (spec) => {
      const [k, v] = spec.replace(/^-+/, "").split("=");
      if (!flags.has(k)) return false;
      return v === undefined ? flags.get(k) !== "false" : String(flags.get(k)) === v;
    };
    const list = new Set([...flags].map(([k, v]) => (v === true ? `-${k}` : `-${k}=${v}`)));
    return { flags, list, pos, vars, multi, has, get: (k) => flags.get(k.replace(/^-+/, "")) };
  }

  const TF_HELP = ["Usage: terraform [global options] <subcommand> [args]", "", "Main commands:", "  init          Prepare your working directory for other commands", "  validate      Check whether the configuration is valid", "  plan          Show changes required by the current configuration", "  apply         Create or update infrastructure", "  destroy       Destroy previously-created infrastructure", "", "All other commands:", "  console       Try Terraform expressions at an interactive command prompt", "  fmt           Reformat your configuration in the standard style", "  force-unlock  Release a stuck lock on the current workspace", "  graph         Generate a Graphviz graph of the steps in an operation", "  import        Associate existing infrastructure with a Terraform resource", "  output        Show output values from your root module", "  providers     Show the providers required for this configuration", "  refresh       Update the state to match remote systems", "  show          Show the current state or a saved plan", "  state         Advanced state management", "  taint         Mark a resource instance as not fully functional", "  untaint       Remove the 'tainted' state from a resource instance", "  version       Show the current Terraform version", "  workspace     Workspace management"];

  function terraform(w, words) {
    const out = [];
    const say = (t, k) => out.push([t, k || null]);
    const fail = (...ds) => { for (const d of ds) out.push(...renderDiag(w, d)); w.status = 1; return out; };
    w.status = 0;
    const sub = words[0];
    const a = parseArgs(words.slice(1));
    if (!sub || sub === "-help" || sub === "--help" || sub === "help") { TF_HELP.forEach((t) => say(t)); return out; }
    if (sub === "-version" || sub === "--version" || sub === "version") {
      say(`Terraform v${w.cli}`);
      say(`on ${w.platform}`);
      for (const [n, v] of Object.entries((w.dot && w.dot.providers) || {})) say(`+ provider ${REG(n)} v${v}`);
      return out;
    }
    if (a.has("-chdir")) return [["The playground has one working directory; run the command without -chdir.", "na"]];
    if (sub === "init") return init(w, a.list);
    if (sub === "fmt") return fmt(w, a, say, out);
    if (sub === "validate") {
      const pr = prepare(w, "validate");
      if (pr.diags.some((d) => d.sev === "Error")) return fail(...pr.diags);
      const p = makePlan(w, pr.cfg, pr.graph, { validateOnly: true, refresh: false, mode: "normal" });
      const errs = p.diags.filter((d) => d.sev === "Error" && !/variable|Value for undeclared/.test(d.summary));
      if (errs.length) return fail(...errs);
      say("Success! The configuration is valid.", "ok");
      return out;
    }
    if (sub === "workspace") return workspace(w, a, say, fail, out);
    if (sub === "state") return stateCmd(w, a, say, fail, out);
    if (sub === "providers") return providersCmd(w, a, say, fail, out);
    if (sub === "output") return outputCmd(w, a, say, out);
    if (sub === "force-unlock") {
      const id = a.pos[0];
      if (!id) return fail(diag("Missing lock ID", "Expected a single argument: LOCK_ID"));
      const key = w.storeKey();
      const l = w.locks[key];
      const unlock = () => {
        if (!l) return [["Failed to unlock state: failed to retrieve lock info for lock ID \"" + id + "\": unexpected end of JSON input", "warn"]];
        if (l.id !== id) return [[`Failed to unlock state: lock ID "${id}" does not match existing lock ID "${l.id}"`, "warn"]];
        delete w.locks[key];
        return [["Terraform state has been successfully unlocked!", "ok"], ["", null], ["The state has been unlocked, and Terraform commands should now be able to", null], ["obtain a new lock on the remote state.", null]];
      };
      if (a.has("-force")) { const r = unlock(); w.status = r[0][1] === "warn" ? 1 : 0; return r; }
      for (const t of ["Do you really want to force-unlock?", "  Terraform will remove the lock on the remote state.", "  This will allow local Terraform commands to modify this state, even though it", "  may still be in use. Only 'yes' will be accepted to confirm.", "", "  Enter a value: "]) say(t, "prompt");
      w.pending = { cmd: "force-unlock", resume: (ans) => (ans === "yes" ? unlock() : [["force-unlock cancelled.", null]]) };
      return out;
    }
    if (sub === "taint" || sub === "untaint") {
      const pr = prepare(w, sub);
      if (!pr.cfg) return fail(...pr.diags);
      const le = holdsLock(w) && !a.has("-lock=false") && lockError(w);
      if (le) return fail(le);
      const addr = a.pos[0];
      const r = w.state.resources[addr];
      if (!r) return fail(diag("No such resource instance", `There is no resource instance in the state with the address ${addr}. If the resource configuration has just been added, you must run "terraform apply" once to create the corresponding instance(s) before they can be tainted.`));
      if (sub === "untaint" && !r.tainted) return fail(diag("Resource instance is not tainted", `Resource instance ${addr} is not currently tainted, and so it cannot be untainted.`));
      r.tainted = sub === "taint";
      w.state.serial++;
      say(sub === "taint" ? `Resource instance ${addr} has been marked as tainted.` : `Resource instance ${addr} has been successfully untainted.`);
      return out;
    }
    if (sub === "import") {
      const [addr, id] = a.pos;
      if (!addr || !id) return fail(diag("Invalid arguments", "The import command expects two arguments: ADDR and ID."));
      const pr = prepare(w, "import");
      if (!pr.cfg) return fail(...pr.diags);
      const le = holdsLock(w) && !a.has("-lock=false") && lockError(w);
      if (le) return fail(le);
      const cfgId = addr.replace(/\[[^\]]*\]$/, "");
      const node = pr.graph.nodes.get(cfgId);
      if (!node || node.kind !== "res") {
        const [type, name] = cfgId.split(".");
        return fail(diag(`resource address "${addr}" does not exist in the configuration.`, `Before importing this resource, please create its configuration in the root module. For example:\n\nresource "${type}" "${name}" {\n  # (resource arguments)\n}`));
      }
      if (w.state.resources[addr]) return fail(diag("Resource already managed by Terraform", `Terraform is already managing a remote object for ${addr}. To import to this address you must first remove the existing object from the state.`));
      const o = w.cloudGet(node.item.type, id);
      say(`${addr}: Importing from ID "${id}"...`);
      if (!o) return fail(diag("Cannot import non-existent remote object", `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`));
      say(`${addr}: Import prepared!`);
      say(`  Prepared ${node.item.type} for import`);
      say(`${addr}: Refreshing state... [id=${id}]`);
      const key = /\[(.+)\]$/.exec(addr);
      w.state.resources[addr] = { addr, mode: "managed", type: node.item.type, name: node.item.name, mp: "", key: key ? JSON.parse(key[1]) : undefined, id, attrs: clone(o.attrs) };
      w.state.serial++;
      for (const t of ["", "Import successful!", "", "The resources that were imported are shown above. These resources are now in", "your Terraform state and will henceforth be managed by Terraform."]) say(t, t === "Import successful!" ? "ok" : null);
      return out;
    }
    if (sub === "console") {
      const pr = prepare(w, "console");
      if (!pr.cfg) return fail(...pr.diags);
      w.console = pr;
      return [];
    }
    if (sub === "show") {
      const file = a.pos[0];
      if (file) {
        const pf = w.planFiles[file];
        if (!pf) return fail(diag("Failed to read the given file as a state or plan file", `State read error: Error loading statefile: open ${file}: no such file or directory\n\nPlan read error: open ${file}: no such file or directory`));
        return renderPlan(w, pf.plan);
      }
      const st = w.states()[w.ws];
      if (!st || !Object.keys(st.resources).length) { say("No state."); return out; }
      for (const addr of Object.keys(st.resources).sort()) out.push(...showResource(w, st.resources[addr]), ["", null]);
      out.push(...outputsBlock(w, st));
      return out;
    }
    if (sub === "graph") {
      const pr = prepare(w, "graph");
      if (!pr.cfg) return fail(...pr.diags);
      say("digraph G {");
      say('  rankdir = "RL";');
      say('  node [shape = rect, fontname = "sans-serif"];');
      const res = [...pr.graph.nodes.values()].filter((n) => n.kind === "res" || n.kind === "data");
      for (const n of res) say(`  "${n.id}" [label="${n.id}"];`);
      for (const n of res) for (const d of n.deps) if (pr.graph.nodes.get(d).kind === "res" || pr.graph.nodes.get(d).kind === "data") say(`  "${n.id}" -> "${d}";`);
      say("}");
      return out;
    }
    if (["plan", "apply", "destroy", "refresh"].includes(sub)) return operation(w, sub, a, say, fail, out, words);
    if (sub === "login" || sub === "logout" || sub === "test" || sub === "get" || sub === "metadata" || sub === "modules") return [[`terraform ${sub} needs a real Terraform installation; the playground does not model it.`, "na"]];
    return fail(diag(`Terraform has no command named "${sub}".`, `To see all of Terraform's top-level commands, run:\n  terraform -help`));
  }

  // plan, apply, destroy and refresh share one path: check, lock, refresh, plan, then
  // either show the plan or ask before applying it.
  function operation(w, sub, a, say, fail, out, words) {
    const key = w.storeKey();
    const announceLock = () => { if (holdsLock(w) && !a.has("-lock=false")) say("Acquiring state lock. This may take a few moments..."); };
    if (sub === "apply" && a.pos[0]) {
      const file = a.pos[0];
      const pf = w.planFiles[file];
      if (!pf) return fail(diag(`Failed to load "${file}" as a plan file`, `Error: stat ${file}: no such file or directory`));
      const pr = prepare(w, "apply");
      if (!pr.cfg) return fail(...pr.diags);
      const le = holdsLock(w) && !a.has("-lock=false") && lockError(w);
      if (le) return fail(le);
      const st = w.state;
      if (pf.lineage !== st.lineage || pf.serial !== st.serial || pf.ws !== w.ws || pf.store !== key) {
        return fail(diag("Saved plan is stale", "The given plan file can no longer be applied because the state was changed by another operation after the plan was created."));
      }
      announceLock();
      out.push(...applyPlan(w, pf.plan));
      return out;
    }
    const mode = sub === "destroy" || a.has("-destroy") ? "destroy" : sub === "refresh" || a.has("-refresh-only") ? "refresh" : "normal";
    const pr = prepare(w, sub);
    if (!pr.cfg) return fail(...pr.diags);
    const bad = a.vars.find((v) => v.bad !== undefined);
    if (bad) return fail(diag("Invalid -var option", `The given -var option "${bad.bad}" is not correctly specified. Must be a variable name and value separated by an equals sign, like -var="key=value".`));
    const le = holdsLock(w) && !a.has("-lock=false") && lockError(w);
    announceLock();
    if (le) return fail(le);
    const p = makePlan(w, pr.cfg, pr.graph, { mode, targets: a.multi.target, replace: a.multi.replace, refresh: !a.has("-refresh=false"), vars: a.vars });
    if (p.missing.length) {
      const v = p.missing[0];
      if (a.has("-input=false") || w.ci) {
        return fail(...p.missing.map((m) => diag("No value for required variable", `The root module input variable "${m.name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, m.at)));
      }
      say(`var.${v.name}`, "prompt");
      say("  Enter a value: ", "prompt");
      w.pending = { cmd: sub, resume: (ans) => terraform(w, [...words, "-var", `${v.name}=${ans}`]) };
      return out;
    }
    const errs = p.diags.filter((d) => d.sev === "Error");
    for (const d of p.diags.filter((x) => x.sev !== "Error")) out.push(...renderDiag(w, d));
    for (const r of Object.values(p.prior.resources)) if (r.mode === "managed" && !a.has("-refresh=false")) say(`${r.addr}: Refreshing state... [id=${r.id}]`);
    for (const d of p.drift.filter((x) => !x.after)) say(`${d.addr}: Refreshing state... [id=${d.r.id}]`);
    if (errs.length) return fail(...errs);
    if (p.targets.length) out.push(...renderDiag(w, diag("Resource targeting is in effect", "You are creating a plan with the -target option, which means that the result of this plan may not represent all of the changes requested by the current configuration.\n\nThe -target option is not for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it as part of an error message.", null, "Warning")));
    const acts = p.changes.filter((c) => c.action !== "noop");
    const outs = Object.values(p.outputs).filter((o) => o.action !== "noop");
    out.push(...renderPlan(w, p));
    const nothing = mode === "refresh" ? !p.drift.length : !acts.length && !outs.length && !p.moves.length;
    w.lastPlan = { ws: w.ws, mode, counts: counts(p), changes: acts.map((c) => ({ addr: c.addr, action: c.action })), nothing, targets: p.targets.length > 0, locked: holdsLock(w) && !a.has("-lock=false"), cli: w.cli, vars: p.V && p.V[""] ? strip(p.V[""].var) : {} };
    if (sub === "plan") {
      if (a.has("-out")) {
        const file = a.get("-out");
        w.planFiles[file] = { plan: p, lineage: w.state.lineage, serial: w.state.serial, ws: w.ws, store: key };
        w.fs[file] = "(binary plan file)";
        say("");
        say("─".repeat(77), "dim");
        say("");
        say(`Saved the plan to: ${file}`);
        say("");
        say("To perform exactly these actions, run the following command to apply:");
        say(`    terraform apply "${file}"`);
      } else if (!nothing) {
        say("");
        say("─".repeat(77), "dim");
        say("");
        say("Note: You didn't use the -out option to save this plan, so Terraform can't");
        say('guarantee to take exactly these actions if you run "terraform apply" now.');
      }
      if (holdsLock(w) && !a.has("-lock=false")) say("Releasing state lock. This may take a few moments...");
      if (a.has("-detailed-exitcode") && !nothing) w.status = 2;
      return out;
    }
    const finish = () => {
      const res = applyPlan(w, p);
      if (!w.status) w.lastPlan.applied = true;
      if (p.targets.length && !w.status) res.push(...renderDiag(w, diag("Applied changes may be incomplete", "The plan was created with the -target option in effect, so some changes requested in the configuration may have been ignored and the output values may not be fully updated. Run the following command to verify that no other changes are pending:\n    terraform plan\n\nNote that the -target option is not suitable for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it as part of an error message.", null, "Warning")));
      return res;
    };
    if (nothing || a.has("-auto-approve") || sub === "refresh") { out.push(...finish()); return out; }
    say("");
    const ws = w.ws === "default" ? "" : ` in workspace "${w.ws}"`;
    const q = mode === "destroy"
      ? [`Do you really want to destroy all resources${ws}?`, "  Terraform will destroy all your managed infrastructure, as shown above.", "  There is no undo. Only 'yes' will be accepted to confirm."]
      : mode === "refresh"
        ? ["Would you like to update the Terraform state to reflect these detected changes?", "  Terraform will write these changes to the state without modifying any real infrastructure.", "  There is no undo. Only 'yes' will be accepted to confirm."]
        : [`Do you want to perform these actions${ws}?`, "  Terraform will perform the actions described above.", "  Only 'yes' will be accepted to approve."];
    for (const t of [...q, "", "  Enter a value: "]) say(t, "prompt");
    w.pending = { cmd: sub, resume: (ans) => {
      if (ans !== "yes") { w.status = 1; return [["", null], [mode === "destroy" ? "Destroy cancelled." : "Apply cancelled.", "warn"]]; }
      return finish();
    } };
    return out;
  }

  function fmt(w, a, say, out) {
    const files = Object.keys(w.fs).filter((f) => /\.(tf|tfvars)$/.test(f) && !f.startsWith(".terraform/") && (a.has("-recursive") || !f.includes("/")) && (!a.pos[0] || a.pos[0] === "." || f === a.pos[0] || f.startsWith(a.pos[0].replace(/\/$/, "") + "/"))).sort();
    const changed = [];
    for (const f of files) {
      let next;
      try { H.parse(w.fs[f]); next = H.format(w.fs[f]); } catch (e) {
        if (!(e instanceof H.HCLError)) throw e;
        out.push(...renderDiag(w, diag(e.summary, e.detail, { file: f, line: e.line })));
        w.status = 2;
        return out;
      }
      if (next === w.fs[f]) continue;
      changed.push(f);
      if (a.has("-diff")) {
        const A = w.fs[f].split("\n");
        const B = next.split("\n");
        say(`--- old/${f}`);
        say(`+++ new/${f}`);
        A.forEach((l, i) => { if (l !== B[i]) { say(`-${l}`, "del"); say(`+${B[i]}`, "add"); } });
      }
      if (!a.has("-check")) w.fs[f] = next;
    }
    for (const f of changed) say(f);
    w.status = a.has("-check") && changed.length ? 3 : 0;
    return out;
  }

  function workspace(w, a, say, fail, out) {
    const [cmd, name] = a.pos;
    const states = w.states();
    const names = () => ["default", ...Object.keys(states).filter((n) => n !== "default").sort()];
    if (cmd === "show") { say(w.ws); return out; }
    if (cmd === "list") { for (const n of names()) say(`${n === w.ws ? "*" : " "} ${n}`); return out; }
    if (!w.dot) return fail(diag("Backend initialization required", 'Run "terraform init" first.'));
    if (!name && cmd !== "list") return fail(diag("Expected a single argument: NAME.", null));
    if (cmd === "new") {
      if (states[name] || name === "default") return fail(diag(`Workspace "${name}" already exists`, null));
      states[name] = emptyState(w);
      w.ws = name;
      for (const t of [`Created and switched to workspace "${name}"!`, "", "You're now on a new, empty workspace. Workspaces isolate their state,", 'so if you run "terraform plan" Terraform will not see any existing state', "for this configuration."]) say(t, t.startsWith("Created") ? "ok" : null);
      return out;
    }
    if (cmd === "select") {
      if (!names().includes(name)) {
        if (a.has("-or-create")) { states[name] = emptyState(w); w.ws = name; say(`Created and switched to workspace "${name}"!`, "ok"); return out; }
        return fail(diag(`Workspace "${name}" doesn't exist.`, 'You can create this workspace with the "new" subcommand\nor include the "-or-create" flag with the "select" subcommand.'));
      }
      w.ws = name;
      say(`Switched to workspace "${name}".`);
      return out;
    }
    if (cmd === "delete") {
      if (!names().includes(name)) return fail(diag(`Workspace "${name}" doesn't exist.`, null));
      if (name === w.ws) return fail(diag(`Workspace "${name}" is your active workspace.`, "You cannot delete the currently active workspace. Please switch\nto another workspace and try again."));
      if (name === "default") return fail(diag("Cannot delete the default workspace", null));
      const res = Object.keys((states[name] || { resources: {} }).resources);
      if (res.length && !a.has("-force")) return fail(diag(`Workspace "${name}" is currently tracking the following resource instances:`, `${res.map((r) => `  - ${r}`).join("\n")}\n\nDeleting this workspace would cause Terraform to lose track of any associated remote objects, which would then require you to delete them manually outside of Terraform. You should destroy these objects with Terraform before deleting the workspace.\n\nIf you want to delete this workspace anyway, and have Terraform forget about these managed objects, use the -force option to disable this safety check.`));
      delete states[name];
      say(`Deleted workspace "${name}"!`, "ok");
      return out;
    }
    return fail(diag(`Unknown workspace subcommand "${cmd || ""}"`, "Usage: terraform workspace [list | select | new | delete | show]"));
  }

  function showResource(w, r) {
    const S = (r.mode === "data" ? DATA_SOURCES : RESOURCES)[r.type] || { args: {} };
    const keys = Object.keys(r.attrs).filter((k) => norm(r.attrs[k], k) !== null || r.attrs[k] === false || r.attrs[k] === 0).sort();
    const wd = Math.max(0, ...keys.map((k) => k.length));
    return [[`# ${r.addr}:`, "dim"], [`${r.mode === "data" ? "data" : "resource"} "${r.type}" "${r.name}" {`, null],
      ...keys.map((k) => [`    ${k.padEnd(wd)} = ${(S.args[k] || "").includes("s") ? "(sensitive value)" : show(r.attrs[k], "    ")}`, null]), ["}", null]];
  }

  function stateJSON(w, st) {
    const groups = {};
    for (const r of Object.values(st.resources)) {
      const k = `${r.mode}.${r.addr.replace(/\[[^\]]*\]$/, "")}`;
      (groups[k] = groups[k] || { ...(r.mp ? { module: r.mp } : {}), mode: r.mode, type: r.type, name: r.name, provider: `provider["${REG(providerOf(r.type))}"]`, instances: [] })
        .instances.push({ ...(r.key !== undefined ? { index_key: r.key } : {}), ...(r.tainted ? { status: "tainted" } : {}), schema_version: 0, attributes: r.attrs, sensitive_attributes: [] });
    }
    return JSON.stringify({ version: 4, terraform_version: st.tfv, serial: st.serial, lineage: st.lineage,
      outputs: Object.fromEntries(Object.entries(st.outputs).map(([k, o]) => [k, { value: o.value, type: typeof o.value === "number" ? "number" : "string", ...(o.sensitive ? { sensitive: true } : {}) }])),
      resources: Object.values(groups), check_results: null }, null, 2);
  }

  function stateCmd(w, a, say, fail, out) {
    const [cmd, x, y] = a.pos;
    const pr = prepare(w, "state");
    if (!pr.cfg && pr.diags.some((d) => /Backend initialization|Error loading state/.test(d.summary))) return fail(...pr.diags);
    const st = w.state;
    const all = Object.keys(st.resources).sort();
    const writing = ["mv", "rm", "push"].includes(cmd);
    if (writing && holdsLock(w) && !a.has("-lock=false")) { const le = lockError(w); if (le) return fail(le); }
    if (cmd === "list") {
      const hits = all.filter((r) => !x || addrMatches(r, x));
      if (x && !hits.length) return fail(diag("No matching objects found.", null));
      for (const r of hits) say(r);
      return out;
    }
    if (cmd === "show") {
      const r = st.resources[x];
      if (!r) return fail(diag(`No instance found for the given address!`, `This command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify\nthe address to reference a specific instance.`));
      return showResource(w, r);
    }
    if (cmd === "pull") return stateJSON(w, st).split("\n").map((t) => [t, null]);
    if (cmd === "mv") {
      if (!x || !y) return fail(diag("Exactly two arguments expected.", null));
      const src = all.filter((r) => addrMatches(r, x) && !(r !== x && /\]$/.test(x)));
      if (!src.length) return fail(diag("Invalid source address", `Cannot move ${x}: does not match anything in the current state.`));
      const moves = src.map((r) => [r, y + r.slice(x.length)]);
      for (const [, to] of moves) if (st.resources[to]) return fail(diag("Invalid target address", `Cannot move to ${to}: there is already a resource instance at that address in the current state.`));
      if (a.has("-dry-run")) { for (const [f, t] of moves) say(`Would move "${f}" to "${t}"`); return out; }
      for (const [f, t] of moves) {
        const r = st.resources[f];
        delete st.resources[f];
        const parts = /^(?:module\.[^.]+\.)?(?:data\.)?([^.]+)\.([^.[]+)(?:\[(.+)\])?$/.exec(t) || [];
        st.resources[t] = { ...r, addr: t, type: parts[1] || r.type, name: parts[2] || r.name, key: parts[3] ? JSON.parse(parts[3]) : undefined };
        say(`Move "${f}" to "${t}"`);
      }
      st.serial++;
      say(`Successfully moved ${moves.length} object(s).`, "ok");
      return out;
    }
    if (cmd === "rm") {
      const targets = a.pos.slice(1);
      const hits = all.filter((r) => targets.some((t) => addrMatches(r, t)));
      if (!hits.length) return fail(diag("Invalid target address", 'No matching objects found. To view the available instances, use "terraform state list". Please modify the address to reference a specific instance.'));
      if (a.has("-dry-run")) { for (const r of hits) say(`Would remove ${r}`); return out; }
      for (const r of hits) { delete st.resources[r]; say(`Removed ${r}`); }
      st.serial++;
      say(`Successfully removed ${hits.length} resource instance(s).`, "ok");
      return out;
    }
    if (cmd === "push" || cmd === "replace-provider" || cmd === "identities") return [[`terraform state ${cmd} rewrites state by hand; the playground leaves it out on purpose. Use state mv, state rm, import, moved and removed blocks.`, "na"]];
    return fail(diag("Usage: terraform [global options] state <subcommand> [options] [args]", "  list   List resources in the state\n  mv     Move an item in the state\n  pull   Pull current state and output to stdout\n  rm     Remove instances from the state\n  show   Show a resource in the state"));
  }

  function providersCmd(w, a, say, fail, out) {
    const cfg = loadConfig(w);
    if (cfg.diags.some((d) => !/^Module /.test(d.summary))) return fail(...cfg.diags);
    if (a.pos[0] === "lock") {
      const platforms = a.multi.platform.length ? a.multi.platform : [w.platform];
      const lock = readLock(w);
      for (const req of requirements(cfg)) {
        const reg = PROVIDERS[req.name];
        const cons = req.constraints.map((c) => c.value);
        const version = lock[req.name] && cons.every((c) => satisfies(lock[req.name].version, c)) ? lock[req.name].version : [...reg.versions].sort(vcmp).reverse().find((v) => cons.every((c) => satisfies(v, c)));
        if (!version) return fail(diag("Could not retrieve providers for locking", `Terraform failed to fetch the requested providers for ${platforms.join(", ")} in order to calculate their checksums: some providers could not be installed:\n- ${REG(req.name)}: no available releases match the given constraints ${cons.join(", ")}.`));
        const l = lock[req.name] && lock[req.name].version === version ? lock[req.name] : { version, constraints: cons.join(", ") || null, hashes: [] };
        for (const pf of platforms) {
          say(`- Fetching ${req.source} ${version} for ${pf}...`);
          say(`- Retrieved ${req.source} ${version} for ${pf} (signed by HashiCorp)`);
          const h = hashFor(pf, version);
          if (!l.hashes.includes(h)) { l.hashes.push(h); say(`- Obtained ${req.source} checksums for ${pf}; Additional checksums for this platform are now tracked in the lock file`); } else say(`- Obtained ${req.source} checksums for ${pf}; All checksums for this platform were already tracked in the lock file`);
        }
        l.hashes.sort();
        lock[req.name] = l;
      }
      writeLock(w, lock);
      for (const t of ["", "Success! Terraform has updated the lock file.", "", "Review the changes in .terraform.lock.hcl and then commit to your", "version control system to retain the new checksums."]) say(t, t.startsWith("Success") ? "ok" : null);
      return out;
    }
    if (a.pos[0]) return [[`terraform providers ${a.pos[0]} is not modelled in the playground; try terraform providers or terraform providers lock.`, "na"]];
    say("");
    say("Providers required by configuration:");
    say(".");
    const mods = Object.values(cfg.mods);
    const line = (mod, pre) => {
      const reqs = [...new Set([...Object.keys(mod.req), ...mod.res.map((r) => providerOf(r.type)), ...mod.data.map((r) => providerOf(r.type))])];
      const kids = mod.calls.filter((c) => c.child && cfg.mods[c.child]);
      const items = [...reqs.map((n) => ["p", n]), ...kids.map((c) => ["m", c])];
      items.forEach(([k, v], i) => {
        const last = i === items.length - 1;
        if (k === "p") say(`${pre}${last ? "└──" : "├──"} provider[${REG(v)}]${mod.req[v] && mod.req[v].version ? " " + mod.req[v].version : ""}`);
        else { say(`${pre}${last ? "└──" : "├──"} module.${v.name}`); line(cfg.mods[v.child], pre + (last ? "    " : "│   ")); }
      });
    };
    line(mods[0], "");
    const inState = [...new Set(Object.values(w.state.resources).map((r) => providerOf(r.type)))];
    if (inState.length) { say(""); say("Providers required by state:"); say(""); for (const n of inState) say(`    provider[${REG(n)}]`); }
    return out;
  }

  function outputCmd(w, a, say, out) {
    const pr = prepare(w, "output");
    if (!pr.cfg && pr.diags.some((d) => /Backend initialization/.test(d.summary))) { out.push(...pr.diags.flatMap((d) => renderDiag(w, d))); w.status = 1; return out; }
    const st = w.states()[w.ws] || emptyState(w);
    const name = a.pos[0];
    if (a.has("-json")) {
      const pick = name ? st.outputs[name] && st.outputs[name].value : Object.fromEntries(Object.entries(st.outputs).map(([k, o]) => [k, { sensitive: o.sensitive, type: typeof o.value === "number" ? "number" : "string", value: o.value }]));
      return JSON.stringify(pick ?? null, null, 2).split("\n").map((t) => [t, null]);
    }
    if (name) {
      const o = st.outputs[name];
      if (!o) { out.push(...renderDiag(w, diag(`Output "${name}" not found`, 'The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run `terraform apply`, since the state won\'t be updated with new output variables until that command is run.'))); w.status = 1; return out; }
      if (a.has("-raw")) return [[typeof o.value === "string" ? o.value : String(o.value), null]];
      return [[show(o.value), null]];
    }
    const names = Object.keys(st.outputs).sort();
    if (!names.length) { out.push(...renderDiag(w, diag("No outputs found", "The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the `output` keyword and run `terraform refresh` for it to become available. If you are using interpolation, please verify the interpolated value is not empty. You can use the `terraform console` command to assist.", null, "Warning"))); return out; }
    for (const k of names) say(`${k} = ${st.outputs[k].sensitive ? "<sensitive>" : show(st.outputs[k].value)}`);
    return out;
  }

  function consoleEval(w, line) {
    const pr = w.console;
    const p = makePlan(w, pr.cfg, pr.graph, { mode: "normal", refresh: false, vars: [] });
    const V = (p.V && p.V[""]) || { var: {}, local: {}, res: {}, data: {}, mod: {} };
    const scope = (name) => (name === "var" ? V.var : name === "local" ? V.local : name === "module" ? V.mod : name === "data" ? V.data : name === "terraform" ? { workspace: w.ws } : name === "path" ? { module: ".", root: ".", cwd: "." } : V.res[name] || (() => { throw new H.EvalError("Reference to undeclared resource", `A managed resource "${name}" has not been declared in the root module.`); })());
    try {
      const v = H.evaluate(H.parseExpr(line, 1), { scope, funcs: { file: (f) => { if (!(f in w.fs)) throw new Error(`no file exists at "${f}"`); return w.fs[f]; } } });
      return [[v instanceof Sens || H.deepSens(v) ? "(sensitive value)" : show(v), null]];
    } catch (e) {
      if (!(e instanceof H.EvalError) && !(e instanceof H.HCLError)) throw e;
      return renderDiag(w, diag(e.summary, e.detail));
    }
  }

  // --- the shell around terraform ------------------------------------------------------------

  // Split a command line like a shell would, honouring quotes. With env,
  // $NAME and ${NAME} expand outside single quotes.
  function tokenize(line, env) {
    const out = [];
    let cur = "";
    let quote = null;
    let has = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (env && ch === "$" && quote !== "'") {
        const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(line.slice(i));
        if (m) { cur += env[m[1] || m[2]] ?? ""; i += m[0].length - 1; continue; }
      }
      if (quote) { if (ch === quote) quote = null; else cur += ch; } else if (ch === "'" || ch === '"') { quote = ch; has = true; } else if (/\s/.test(ch)) {
        if (cur || has) out.push(cur);
        cur = "";
        has = false;
      } else cur += ch;
    }
    if (cur || has) out.push(cur);
    return out;
  }

  // Split on ; && and | outside quotes: [{ op, text }].
  function splitLine(line) {
    const parts = [];
    let cur = "";
    let quote = null;
    let op = ";";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||") { parts.push({ op, text: cur.trim() }); op = two; cur = ""; i++; continue; }
      if (ch === ";" || ch === "|") { parts.push({ op, text: cur.trim() }); op = ch; cur = ""; continue; }
      cur += ch;
    }
    parts.push({ op, text: cur.trim() });
    return parts.filter((p) => p.text);
  }

  const HELP = [
    "terraform init | validate | fmt [-check] [-diff] | plan [-out=FILE] [-target=ADDR] [-replace=ADDR] [-var k=v] [-var-file=F] [-refresh-only]",
    "terraform apply [-auto-approve] [FILE] | destroy | output [NAME] [-json|-raw] | show | graph | providers [lock -platform=P]",
    "terraform state list | show ADDR | mv SRC DST | rm ADDR | pull     terraform import ADDR ID     terraform taint|untaint ADDR",
    "terraform workspace list | show | new NAME | select NAME | delete NAME     terraform force-unlock LOCK_ID     terraform console (exit to leave)",
    "Answer prompts by typing yes (or a value). Files: ls [-a], cat [-n] FILE, edit FILE (opens the editor), sed -i 's/old/new/' FILE,",
    "  echo 'text' >> FILE, rm FILE, mv A B, grep -rn TEXT .     Environment: export TF_VAR_name=value, unset NAME, env",
    "Tools: tfenv list | install V | use V,  aws sts get-caller-identity | s3 ls | ec2 describe-instances | ec2 describe-security-groups |",
    "  ec2 describe-vpcs | ec2 describe-instance-status | rds describe-db-instances | autoscaling describe-auto-scaling-groups | dynamodb scan --table-name T",
    "  ci run: run .github/workflows/terraform.yml in a fresh checkout on a simulated Linux runner (only files git would commit).",
    "Playground: hint, reset, next, clear. Pipes: | grep TEXT, | head -n N, | tail -n N, | wc -l"
  ];

  const HOME = "/home/dev/infra";
  const na = (t) => [[t, "na"]];

  function filter(lines, words) {
    const [cmd, ...args] = words;
    const text = lines.map(([t]) => t);
    const keep = (arr) => lines.filter((l) => arr.includes(l));
    if (cmd === "grep") {
      const inv = args.includes("-v");
      const ins = args.includes("-i");
      const pat = args.filter((x) => !/^-/.test(x))[0] || "";
      let rx;
      try { rx = new RegExp(pat, ins ? "i" : ""); } catch { rx = { test: (s) => s.includes(pat) }; }
      return lines.filter(([t]) => rx.test(t) !== inv);
    }
    const n = Number((args.join(" ").match(/\d+/) || ["10"])[0]);
    if (cmd === "head") return lines.slice(0, n);
    if (cmd === "tail") return lines.slice(-n);
    if (cmd === "wc") return [[String(text.length), null]];
    if (cmd === "sort") return [...lines].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (cmd === "less" || cmd === "more" || cmd === "cat") return keep(lines);
    return na(`${cmd}: the playground pipes into grep, head, tail, wc -l and sort only.`);
  }

  // sed's basic regular expressions: + ? ( ) { } | are literal unless escaped,
  // and $ is an anchor only at the end. -E switches to extended syntax.
  function sedRegex(pat, ere, flags) {
    let rx = pat;
    if (!ere) {
      rx = "";
      for (let i = 0; i < pat.length; i++) {
        const c = pat[i];
        if (c === "\\" && i + 1 < pat.length) { const n = pat[++i]; rx += "+?(){}|".includes(n) ? n : "\\" + n; } else if ("+?(){}|".includes(c)) rx += "\\" + c;
        else if (c === "$" && i !== pat.length - 1) rx += "\\$";
        else rx += c;
      }
    }
    return new RegExp(rx, flags);
  }
  function sedApply(text, expr, ere) {
    const s = /^s(.)(.*?)\1(.*?)\1(g?)$/.exec(expr);
    try {
      if (s) {
        const rx = sedRegex(s[2], ere, s[4] ? "g" : "");
        const rep = s[3].replace(/\$/g, "$$$$").replace(/\\([0-9])/g, "$$$1").replace(/(^|[^\\])&/g, "$1$$&").replace(/\\&/g, "&");
        return text.split("\n").map((l) => l.replace(rx, rep)).join("\n");
      }
      const d = /^\/(.*)\/d$/.exec(expr);
      if (d) { const rx = sedRegex(d[1], ere, ""); return text.split("\n").filter((l) => !rx.test(l)).join("\n"); }
    } catch { return null; }
    return null;
  }

  function files(w, words) {
    const [cmd, ...args] = words;
    const opts = args.filter((x) => /^-/.test(x));
    const pos = args.filter((x) => !/^-/.test(x));
    const exists = (f) => f in w.fs || virtualFile(w, f) !== null;
    const read = (f) => (f in w.fs ? w.fs[f] : virtualFile(w, f));
    if (cmd === "ls") {
      const dir = (pos[0] || "").replace(/\/$/, "").replace(/^\.$/, "");
      const all = opts.some((o) => o.includes("a"));
      const names = new Set();
      const list = [...Object.keys(w.fs), ...(virtualFile(w, "terraform.tfstate") !== null ? ["terraform.tfstate"] : []), ...(w.dot ? [".terraform/terraform.tfstate"] : [])];
      for (const f of list) {
        if (dir && !f.startsWith(dir + "/")) continue;
        const rest = dir ? f.slice(dir.length + 1) : f;
        const name = rest.includes("/") ? rest.split("/")[0] + "/" : rest;
        if (name.startsWith(".") && !all) continue;
        names.add(name);
      }
      if (dir && !names.size) return [[`ls: cannot access '${dir}': No such file or directory`, "warn"]];
      return [[[...names].sort().join("  "), null]];
    }
    if (cmd === "cat") {
      if (!pos.length) return na("cat: give a file name, for example: cat main.tf");
      const out = [];
      for (const f of pos) {
        if (!exists(f)) { out.push([`cat: ${f}: No such file or directory`, "warn"]); w.status = 1; continue; }
        const lines = read(f).replace(/\n$/, "").split("\n");
        lines.forEach((l, i) => out.push([opts.includes("-n") ? `${String(i + 1).padStart(6)}\t${l}` : l, null]));
      }
      return out;
    }
    if (cmd === "edit" || cmd === "nano" || cmd === "vim" || cmd === "vi" || cmd === "code") {
      const f = pos[0];
      if (!f) return na("edit: give a file name, for example: edit main.tf");
      if (f.startsWith(".terraform/")) return na("Files under .terraform/ belong to terraform init; edit your own .tf files instead.");
      if (!(f in w.fs)) w.fs[f] = "";
      w.editing = f;
      return [[`Editing ${f} in the editor beside the terminal. Changes are saved as you type.`, "dim"]];
    }
    if (cmd === "sed") {
      const expr = pos[0];
      const targets = pos.slice(1);
      if (!opts.includes("-i")) return na("Use sed -i 's/old/new/' FILE to edit a file in place.");
      const out = [];
      for (const f of targets) {
        if (!(f in w.fs)) { out.push([`sed: can't read ${f}: No such file or directory`, "warn"]); w.status = 2; continue; }
        const next = sedApply(w.fs[f], expr || "", opts.some((o) => /E|r/.test(o)));
        if (next === null) return [[`sed: -e expression #1, char ${String(expr || "").length}: unknown command: \`${String(expr || " ")[0]}'`, "warn"]];
        w.fs[f] = next;
      }
      return out;
    }
    if (cmd === "rm") {
      const out = [];
      for (const f of pos) {
        const p = f.replace(/\/$/, "");
        if (p === ".terraform") { if (!opts.some((o) => o.includes("r"))) { out.push([`rm: cannot remove '${f}': Is a directory`, "warn"]); continue; } for (const k of Object.keys(w.fs)) if (k.startsWith(".terraform/")) delete w.fs[k]; w.dot = null; continue; }
        if (p === "terraform.tfstate" && w.storeKey() === "local" && virtualFile(w, p) !== null) { w.stores.local = { default: null }; continue; }
        const under = Object.keys(w.fs).filter((k) => k.startsWith(p + "/"));
        if (under.length) { if (!opts.some((o) => o.includes("r"))) { out.push([`rm: cannot remove '${f}': Is a directory`, "warn"]); continue; } under.forEach((k) => delete w.fs[k]); continue; }
        if (!(p in w.fs)) { out.push([`rm: cannot remove '${f}': No such file or directory`, "warn"]); w.status = 1; continue; }
        delete w.fs[p];
        if (w.planFiles[p]) delete w.planFiles[p];
      }
      return out;
    }
    if (cmd === "mv" || cmd === "cp") {
      const [a, b] = pos;
      if (!a || !b) return [[`${cmd}: missing destination file operand after '${a || ""}'`, "warn"]];
      if (!(a in w.fs)) return [[`${cmd}: cannot stat '${a}': No such file or directory`, "warn"]];
      const dest = b.endsWith("/") ? b + a.split("/").pop() : b;
      w.fs[dest] = w.fs[a];
      if (cmd === "mv") delete w.fs[a];
      return [];
    }
    if (cmd === "touch") { for (const f of pos) if (!(f in w.fs)) w.fs[f] = ""; return []; }
    if (cmd === "mkdir") return [];
    if (cmd === "grep") {
      const pat = pos[0];
      if (!pat) return [["Usage: grep [OPTION]... PATTERNS [FILE]...", "warn"]];
      const recursive = opts.some((o) => /r/.test(o));
      const ins = opts.some((o) => /i/.test(o));
      const num = opts.some((o) => /n/.test(o));
      let targets = pos.slice(1);
      if (recursive) targets = Object.keys(w.fs).filter((f) => !f.startsWith(".terraform/") && (!targets.length || targets.some((t) => t === "." || f === t || f.startsWith(t.replace(/\/$/, "") + "/")))).sort();
      let rx;
      try { rx = new RegExp(pat, ins ? "i" : ""); } catch { rx = { test: (s) => s.includes(pat) }; }
      const out = [];
      for (const f of targets) {
        if (!(f in w.fs)) { out.push([`grep: ${f}: No such file or directory`, "warn"]); continue; }
        w.fs[f].split("\n").forEach((l, i) => { if (rx.test(l)) out.push([`${targets.length > 1 || recursive ? f + ":" : ""}${num ? i + 1 + ":" : ""}${l}`, null]); });
      }
      if (!out.length) w.status = 1;
      return out;
    }
    return null;
  }

  // Files that exist because of state: the local backend's state file.
  function virtualFile(w, f) {
    if (f === "terraform.tfstate" && w.storeKey() === "local" && w.states("local").default) return stateJSON(w, w.states("local").default);
    return null;
  }

  function tfenv(w, words) {
    const [cmd, v] = words;
    if (cmd === "list") return [...w.installed].sort(vcmp).reverse().map((x) => [`${x === w.cli ? "* " : "  "}${x}${x === w.cli ? " (set by /home/dev/.tfenv/version)" : ""}`, null]);
    if (cmd === "list-remote") return [...CLI_VERSIONS].sort(vcmp).reverse().map((x) => [x, null]);
    if (cmd === "install") {
      const want = v === "latest" ? [...CLI_VERSIONS].sort(vcmp).pop() : v;
      if (!CLI_VERSIONS.includes(want)) return [[`No versions matching '${v || ""}' found in remote`, "warn"]];
      w.installed.add(want);
      return [[`Installing Terraform v${want}`, null], [`Downloading release tarball from https://releases.hashicorp.com/terraform/${want}/terraform_${want}_${w.platform}.zip`, "dim"], [`Installation of terraform v${want} successful. To make this your default version, run 'tfenv use ${want}'`, "ok"]];
    }
    if (cmd === "use") {
      if (!w.installed.has(v)) return [[`No installed versions of terraform matched '^${v || ""}$'`, "warn"]];
      w.cli = v;
      return [[`Switching default version to v${v}`, null], [`Default version (when not overridden by .terraform-version or TFENV_TERRAFORM_VERSION) is now: ${v}`, "ok"]];
    }
    return na("tfenv list | list-remote | install VERSION | use VERSION");
  }

  function awsCli(w, words) {
    const json = (o) => JSON.stringify(o, null, 4).split("\n").map((t) => [t, null]);
    const flag = (name) => { const i = words.indexOf(name); return i >= 0 ? words[i + 1] : null; };
    if (!w.env.AWS_PROFILE && !w.env.AWS_ACCESS_KEY_ID) return [["", null], ['Unable to locate credentials. You can configure credentials by running "aws configure".', "warn"]];
    const [svc, op] = words;
    const tagList = (t) => Object.entries(t || {}).map(([Key, Value]) => ({ Key, Value }));
    if (svc === "sts" && op === "get-caller-identity") return json({ UserId: "AIDAQUESTPRACTICE0001", Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/quest` });
    if (svc === "s3" && op === "ls") {
      if (words[2]) {
        const b = w.cloudGet("aws_s3_bucket", words[2].replace(/^s3:\/\//, "").replace(/\/.*$/, ""));
        if (!b) return [["", null], ["An error occurred (NoSuchBucket) when calling the ListObjectsV2 operation: The specified bucket does not exist", "warn"]];
        return Array.from({ length: Math.min(b.extra.objects || 0, 5) }, (_, i) => [`2026-10-2${i} 0${i}:14:0${i}     ${18231 + i * 977} report-2026-10-2${i}.csv`, null]);
      }
      return w.cloudAll("aws_s3_bucket").map((o) => [`2026-10-0${1 + (o.id.length % 9)} 09:${10 + (o.id.length % 49)}:44 ${o.id}`, null]);
    }
    if (svc === "ec2" && op === "describe-instances") return json({ Reservations: [{ Instances: w.cloudAll("aws_instance").map((o) => ({ InstanceId: o.id, InstanceType: o.attrs.instance_type, ImageId: o.attrs.ami, State: { Name: o.attrs.instance_state || "running" }, SecurityGroups: (o.attrs.vpc_security_group_ids || []).map((g) => ({ GroupId: g })), Tags: tagList(o.attrs.tags) })) }] });
    if (svc === "ec2" && op === "describe-instance-status") {
      const ids = flag("--instance-ids");
      return json({ InstanceStatuses: w.cloudAll("aws_instance").filter((o) => !ids || ids.split(",").includes(o.id)).map((o) => ({ InstanceId: o.id, InstanceState: { Name: "running" }, InstanceStatus: { Status: o.extra.impaired ? "impaired" : "ok", Details: [{ Name: "reachability", Status: o.extra.impaired ? "failed" : "passed" }] }, SystemStatus: { Status: "ok" } })) });
    }
    if (svc === "ec2" && op === "describe-security-groups") {
      const ids = flag("--group-ids");
      return json({ SecurityGroups: w.cloudAll("aws_security_group").filter((o) => !ids || ids.split(",").includes(o.id)).map((o) => ({ GroupId: o.id, GroupName: o.attrs.name, VpcId: o.attrs.vpc_id, IpPermissions: [...(o.attrs.ingress || []).map((r) => ({ IpProtocol: r.protocol, FromPort: r.from_port, ToPort: r.to_port, IpRanges: (r.cidr_blocks || []).map((c) => ({ CidrIp: c })) })), ...w.cloudAll("aws_vpc_security_group_ingress_rule").filter((r) => r.attrs.security_group_id === o.id).map((r) => ({ IpProtocol: r.attrs.ip_protocol, FromPort: r.attrs.from_port, ToPort: r.attrs.to_port, ...(r.attrs.cidr_ipv4 ? { IpRanges: [{ CidrIp: r.attrs.cidr_ipv4 }] } : {}), ...(r.attrs.referenced_security_group_id ? { UserIdGroupPairs: [{ GroupId: r.attrs.referenced_security_group_id }] } : {}) }))] })) });
    }
    if (svc === "ec2" && op === "describe-vpcs") return json({ Vpcs: w.cloudAll("aws_vpc").map((o) => ({ VpcId: o.id, CidrBlock: o.attrs.cidr_block, Tags: tagList(o.attrs.tags) })) });
    if (svc === "rds" && op === "describe-db-instances") return json({ DBInstances: w.cloudAll("aws_db_instance").map((o) => ({ DBInstanceIdentifier: o.attrs.identifier, Engine: o.attrs.engine, EngineVersion: o.attrs.engine_version, DBInstanceStatus: "available", InstanceCreateTime: o.extra.created || "2024-03-11T08:21:40.512Z", DeletionProtection: Boolean(o.attrs.deletion_protection) })) });
    if (svc === "autoscaling" && op === "describe-auto-scaling-groups") return json({ AutoScalingGroups: w.cloudAll("aws_autoscaling_group").map((o) => ({ AutoScalingGroupName: o.attrs.name, MinSize: o.attrs.min_size, MaxSize: o.attrs.max_size, DesiredCapacity: o.attrs.desired_capacity })) });
    if (svc === "dynamodb" && op === "scan") {
      const t = flag("--table-name");
      if (!w.cloudAll("aws_dynamodb_table").some((o) => o.attrs.name === t)) return [["", null], [`An error occurred (ResourceNotFoundException) when calling the Scan operation: Requested resource not found`, "warn"]];
      const items = Object.entries(w.locks).filter(([k]) => k.startsWith("s3://")).map(([k, l]) => ({ LockID: { S: k.replace("s3://", "") }, Info: { S: JSON.stringify({ ID: l.id, Operation: l.op, Who: l.who, Version: l.version, Created: l.created, Path: l.path }) } }));
      return json({ Items: items, Count: items.length, ScannedCount: items.length });
    }
    return na("The playground models these read-only aws commands: sts get-caller-identity, s3 ls, ec2 describe-instances | describe-instance-status | describe-security-groups | describe-vpcs, rds describe-db-instances, autoscaling describe-auto-scaling-groups, dynamodb scan --table-name T.");
  }

  // A CI run: a fresh checkout of what git would commit, on a Linux runner, with
  // the workflow's env, sharing the remote backend and the cloud with you.
  function ciRun(w) {
    const wf = w.fs[".github/workflows/terraform.yml"];
    if (!wf) return na("This scenario has no CI workflow (.github/workflows/terraform.yml).");
    const ci = new World(w.scenario, true);
    for (const k of ["stores", "locks", "cloud", "lost", "applied", "rand", "installed"]) ci[k] = w[k];
    ci.fs = Object.fromEntries(Object.entries(w.fs).filter(([f]) => !w.ignored(f)));
    ci.platform = RUNNER;
    ci.ci = true;
    ci.mirror = w.mirror;
    ci.cli = (/terraform_version:\s*"?([\d.]+)/.exec(wf) || [])[1] || CLI;
    ci.env = { AWS_ACCESS_KEY_ID: "(from OIDC)" };
    for (const m of wf.matchAll(/^[ \t]+([A-Z][A-Za-z0-9_]*):[ \t]*(.*)$/gm)) {
      let v = m[2].trim().replace(/^["']|["']$/g, "");
      const sec = /\$\{\{\s*secrets\.(\w+)\s*\}\}/.exec(v);
      if (sec) v = (w.scenario.ciSecrets || {})[sec[1]] || "";
      ci.env[m[1]] = v;
    }
    if (ci.env.TF_WORKSPACE) ci.ws = ci.env.TF_WORKSPACE;
    const steps = [...wf.matchAll(/^\s*-?\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());
    const out = [["ci: fresh checkout on ubuntu-latest (linux_amd64), terraform " + ci.cli, "dim"]];
    let ok = true;
    for (const step of steps) {
      out.push(["", null], [`▶ Run ${step}`, "cmd"]);
      const res = shell(ci, step);
      out.push(...res);
      if (ci.pending) { ci.pending = null; ci.status = 1; out.push(["Error: the runner has no terminal to answer prompts. Use -input=false and -auto-approve, or supply every value.", "warn"]); }
      if (ci.status) { out.push([`Error: Process completed with exit code ${ci.status}.`, "warn"]); ok = false; break; }
    }
    out.push(["", null], ok ? ["✓ CI passed", "ok"] : ["✗ CI failed", "warn"]);
    w.ciRuns.push({ ok, steps: steps.length, env: ci.env, plan: ci.lastPlan || null });
    w.status = ok ? 0 : 1;
    return out;
  }

  // One command line: chains (;, &&, ||), pipes into filters, and env prefixes.
  function shell(w, raw) {
    const line = String(raw).trim();
    w.status = 0;
    if (w.pending) {
      const p = w.pending;
      w.pending = null;
      return p.resume(line);
    }
    if (w.console) {
      if (line === "exit" || line === "quit") { w.console = null; return []; }
      if (!line) return [];
      return consoleEval(w, line);
    }
    if (!line) return [];
    const parts = splitLine(line);
    let out = [];
    let lastOk = true;
    for (let i = 0; i < parts.length; i++) {
      const { op, text } = parts[i];
      if (op === "|") continue;
      if (op === "&&" && !lastOk) break;
      if (op === "||" && lastOk) continue;
      // Collect this command's pipeline.
      const pipe = [];
      let j = i + 1;
      while (j < parts.length && parts[j].op === "|") pipe.push(parts[j++].text);
      let res;
      const consoleIn = pipe[0] && /^terraform console\b/.test(pipe[0]) && /^echo\s/.test(text);
      if (consoleIn) {
        const pr = prepare(w, "console");
        if (!pr.cfg) res = pr.diags.flatMap((d) => renderDiag(w, d));
        else { w.console = pr; res = consoleEval(w, tokenize(text).slice(1).join(" ")); w.console = null; }
        pipe.shift();
      } else res = command(w, text);
      for (const f of pipe) res = filter(res, tokenize(f));
      out = out.concat(res);
      lastOk = w.status === 0;
    }
    return out;
  }

  function command(w, text) {
    let words = tokenize(text, w.env);
    const env = {};
    while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const [k, ...v] = words.shift().split("=");
      env[k] = v.join("=");
    }
    const [cmd, ...args] = words;
    const saved = { ...w.env };
    Object.assign(w.env, env);
    try {
      if (cmd === "terraform") return terraform(w, args);
      if (cmd === "tofu") return na("The playground simulates the terraform CLI. With OpenTofu installed, the same command is tofu " + args.join(" ") + "; its output says OpenTofu where this says Terraform.");
      if (cmd === "help") return HELP.map((t) => [t, "dim"]);
      if (cmd === "export") {
        for (const a of args) { const [k, ...v] = a.split("="); if (v.length) w.env[k] = v.join("="); }
        return [];
      }
      if (cmd === "unset") { for (const k of args) { delete w.env[k]; delete saved[k]; } return []; }
      if (cmd === "env" || cmd === "printenv") {
        const keys = Object.keys(w.env).filter((k) => w.env[k] !== undefined).sort();
        return args[0] ? (w.env[args[0]] !== undefined ? [[w.env[args[0]], null]] : []) : [["HOME=/home/dev", null], ["PWD=" + HOME, null], ...keys.map((k) => [`${k}=${w.env[k]}`, null])];
      }
      if (cmd === "echo") {
        const r = args.indexOf(">") >= 0 ? args.indexOf(">") : args.indexOf(">>");
        if (r >= 0) {
          const f = args[r + 1];
          if (!f) return [["bash: syntax error near unexpected token `newline'", "warn"]];
          const text2 = args.slice(0, r).join(" ") + "\n";
          w.fs[f] = args[r] === ">>" ? (w.fs[f] || "") + (w.fs[f] && !w.fs[f].endsWith("\n") ? "\n" : "") + text2 : text2;
          return [];
        }
        return [[args.join(" "), null]];
      }
      if (cmd === "pwd") return [[HOME, null]];
      if (cmd === "cd") return !args[0] || args[0] === "." || args[0] === HOME || args[0] === "~/infra" ? [] : na("The playground works in one directory (~/infra). Read module files by path instead, for example: cat modules/network/main.tf");
      if (cmd === "which") return args[0] === "terraform" ? [["/home/dev/.tfenv/bin/terraform", null]] : args[0] === "aws" ? [["/usr/local/bin/aws", null]] : [];
      if (cmd === "clear") return [];
      if (cmd === "tfenv") return tfenv(w, args);
      if (cmd === "aws") return awsCli(w, args);
      if (cmd === "ci") return args[0] === "run" ? ciRun(w) : na("ci run: run .github/workflows/terraform.yml on a simulated runner.");
      if (cmd === "yes" || cmd === "no") return na("Nothing is waiting for an answer. Terraform asks after plan output; type yes then.");
      if (cmd === "git" || cmd === "gh") return na(`${cmd} is not modelled here. ci run runs the workflow on a fresh checkout of what git would commit (files not in .gitignore).`);
      if (cmd === "jq") return na("jq is not modelled; terraform output -raw NAME prints one value.");
      const f = files(w, words);
      if (f) return f;
      w.status = 127;
      return [[`bash: ${cmd}: command not found`, "warn"]];
    } finally {
      for (const k of Object.keys(env)) { if (k in saved) w.env[k] = saved[k]; else delete w.env[k]; }
    }
  }

  // --- scenarios -------------------------------------------------------------------------

  // Configuration files are written indented in this source and dedented here.
  function hcl(text) {
    const lines = text.replace(/^\n/, "").replace(/\s+$/, "").split("\n");
    const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length));
    return lines.map((l) => l.slice(pad)).join("\n") + "\n";
  }
  const GITIGNORE = ".terraform/\n*.tfstate\n*.tfstate.*\n*.tfvars\ncrash.log\n";
  const versions = (aws = "~> 5.0", extra = "") => hcl(`
    terraform {
      required_version = ">= 1.5"

      required_providers {
        aws = {
          source  = "hashicorp/aws"
          version = "${aws}"
        }
      }${extra}
    }

    provider "aws" {
      region = "eu-west-1"
    }
  `);
  const S3_BACKEND = (extra = "") => `

      backend "s3" {
        bucket         = "quest-tfstate"
        key            = "shop/terraform.tfstate"
        region         = "eu-west-1"
        dynamodb_table = "tf-locks"${extra}
      }`;
  const STATE_BUCKET = [{ type: "aws_s3_bucket", id: "quest-tfstate", attrs: { bucket: "quest-tfstate", arn: "arn:aws:s3:::quest-tfstate" }, extra: { objects: 3 } },
    { type: "aws_dynamodb_table", id: "tf-locks", attrs: { name: "tf-locks", hash_key: "LockID" } }];
  const VPC = { type: "aws_vpc", id: "vpc-0a1b2c3d4e5f60718", attrs: { cidr_block: "10.0.0.0/16", tags: { Name: "shop-vpc" } } };
  const AMI = "ami-0c1d2e3f4a5b6c7d8";
  const workflow = (steps, env = "") => hcl(`
    name: terraform
    on: [pull_request]
    permissions:
      contents: read
    jobs:
      terraform:
        runs-on: ubuntu-latest${env}
        steps:
          - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
          - uses: hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1
            with:
              terraform_version: "1.10.5"
${steps.map((x) => `          - run: ${x}`).join("\n")}
  `);
  const inState = (w, addr) => Boolean(w.state.resources[addr]);
  const live = (w, type, id) => Boolean(w.cloudGet(type, id));
  const attrOf = (w, addr, k) => { const r = w.state.resources[addr]; const o = r && w.cloudGet(r.type, r.id); return o ? o.attrs[k] : undefined; };
  const cleanPlan = (w) => { const p = w.lastPlan; return Boolean(p && p.nothing && p.ws === w.ws && p.mode === "normal" && !p.targets); };
  // Would this configuration plan in a brand-new environment (empty state)?
  function freshPlanOk(w, extra = []) {
    const t = new World(w.scenario, true);
    Object.assign(t, { fs: { ...w.fs }, dot: w.dot, cloud: clone(w.cloud), env: { ...w.env }, cli: w.cli, installed: w.installed, rand: w.rand });
    shell(t, ["terraform plan -input=false", ...extra].join(" "));
    return t.status === 0;
  }
  const filesText = (w) => Object.entries(w.fs).filter(([f]) => !f.startsWith(".terraform/") && /\.(tf|tfvars)$/.test(f)).map(([, t]) => t).join("\n");

  const SCENARIOS = [
    {
      id: "noinit",
      title: "Forgot terraform init",
      level: "00",
      story: "You cloned the infra repository to add the website bucket. terraform plan stops before it shows anything.",
      goal: "Create the bucket quest-site-2026.",
      done: "The bucket exists and Terraform manages it.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "site" {
            bucket = "quest-site-2026"

            tags = {
              Team = "web"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      won: (w) => live(w, "aws_s3_bucket", "quest-site-2026") && inState(w, "aws_s3_bucket.site"),
      check: (w) => ({ label: "Bucket quest-site-2026", ok: live(w, "aws_s3_bucket", "quest-site-2026"), text: live(w, "aws_s3_bucket", "quest-site-2026") ? "created" : w.dot ? "initialised, not created" : "not initialised" }),
      hints: [
        "Run terraform plan and read the last lines of the error: which command does it ask for?",
        "terraform init downloads the providers the configuration needs, records their versions in .terraform.lock.hcl and sets up the backend.",
        "Run terraform init, then terraform apply and answer yes."
      ],
      lesson: "Every new checkout, new provider, module or backend needs terraform init first. Commit .terraform.lock.hcl so everyone gets the same provider versions.",
      tries: ["terraform plan", "ls -a"]
    },
    {
      id: "unsupported",
      title: "Unsupported argument",
      level: "01",
      story: "A teammate wrote the web server by hand in a hurry. Validation fails on a single line.",
      goal: "Create the web instance as a t3.small.",
      done: "The web instance runs as a t3.small.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_instance" "web" {
            ami          = "${AMI}"
            instance_typ = "t3.small"

            tags = {
              Name = "web"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => attrOf(w, "aws_instance.web", "instance_type") === "t3.small",
      check: (w) => ({ label: "web instance", ok: attrOf(w, "aws_instance.web", "instance_type") === "t3.small", text: attrOf(w, "aws_instance.web", "instance_type") || "not created" }),
      hints: [
        "terraform validate. Which line, and what does Terraform suggest?",
        "Argument names come from the provider's schema. A typo is not ignored: it stops the whole run.",
        "edit main.tf (or sed -i 's/instance_typ /instance_type/' main.tf), then terraform fmt, terraform validate and terraform apply."
      ],
      lesson: "Terraform checks every argument against the provider schema and says \"Did you mean\". Deleting the line is not the fix: the instance would get the default size.",
      tries: ["terraform validate", "cat -n main.tf"]
    },
    {
      id: "invalidref",
      title: "Invalid reference",
      level: "01",
      story: "The reports bucket should be tagged with its environment. Someone wrote the variable without its prefix.",
      goal: "Create the reports bucket tagged Name = reports-staging.",
      done: "The bucket is tagged reports-staging.",
      files: {
        "versions.tf": versions(),
        "variables.tf": hcl(`
          variable "env" {
            description = "Environment name"
            type        = string
            default     = "staging"
          }
        `),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "reports" {
            bucket = "quest-reports-staging"

            tags = {
              Name        = "reports-\${env}"
              Environment = var.env
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => (attrOf(w, "aws_s3_bucket.reports", "tags") || {}).Name === "reports-staging",
      check: (w) => { const t = (attrOf(w, "aws_s3_bucket.reports", "tags") || {}).Name; return { label: "Name tag", ok: t === "reports-staging", text: t || "bucket not created" }; },
      hints: [
        "terraform validate shows the line. What kind of name is env on its own?",
        "A bare word is read as a resource type. Input variables are always var.<name>, locals local.<name>.",
        "Change \${env} to \${var.env} in main.tf, then terraform apply."
      ],
      lesson: "References have a namespace: var., local., module., data. or a resource type. Typing the value as text (reports-env) silences the error but tags the bucket wrongly.",
      tries: ["terraform validate", "cat main.tf"]
    },
    {
      id: "fmtcheck",
      title: "CI fails on terraform fmt",
      level: "00",
      story: "Your pull request is red. The first CI step, terraform fmt -check, exits with code 3 and prints a file name.",
      goal: "Make the CI workflow pass.",
      done: "CI passes.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "logs" {
              bucket = "quest-logs-2026"
            force_destroy = false

            tags = {
              Team = "platform"
                Purpose     = "access logs"
            }
          }
        `),
        ".github/workflows/terraform.yml": workflow(["terraform fmt -check -recursive", "terraform init -backend=false -input=false", "terraform validate"]),
        ".gitignore": GITIGNORE
      },
      won: (w) => w.ciRuns.length > 0 && w.ciRuns[w.ciRuns.length - 1].ok,
      check: (w) => ({ label: "CI", ok: w.ciRuns.length > 0 && w.ciRuns[w.ciRuns.length - 1].ok, text: !w.ciRuns.length ? "not run yet" : w.ciRuns[w.ciRuns.length - 1].ok ? "passing" : "failing" }),
      hints: [
        "ci run shows the failing step. terraform fmt -check lists the files it would change; -diff shows how.",
        "terraform fmt -check only reports. terraform fmt rewrites the files: indentation and aligned = signs.",
        "terraform fmt, then ci run."
      ],
      lesson: "fmt -check exits 3 when a file is not in canonical style. Run terraform fmt -recursive before you push, or in a pre-commit hook.",
      tries: ["ci run", "terraform fmt -check -diff"]
    },
    {
      id: "outputmissing",
      title: "No outputs found",
      level: "02",
      story: "You added outputs.tf so the deploy script can read the bucket name, but terraform output says there are none.",
      goal: "Make terraform output show site_bucket.",
      done: "terraform output shows site_bucket.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "site" {
            bucket = "quest-site-2026"
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["outputs.tf"] = hcl(`
          output "site_bucket" {
            description = "Bucket the deploy script uploads to"
            value       = aws_s3_bucket.site.bucket
          }
        `);
      },
      won: (w) => Boolean(w.state.outputs.site_bucket),
      check: (w) => ({ label: "site_bucket output", ok: Boolean(w.state.outputs.site_bucket), text: w.state.outputs.site_bucket ? "in state" : "not in state" }),
      hints: [
        "terraform output reads the state, not your files. Does terraform plan mention outputs?",
        "Outputs are saved to the state when Terraform applies. A plan only shows what would change.",
        "terraform apply (it changes no infrastructure, only saves the output), then terraform output."
      ],
      lesson: "Output values live in the state. Adding an output block changes nothing until an apply (or apply -refresh-only) writes it.",
      tries: ["terraform output", "terraform plan"]
    },
    {
      id: "drift",
      title: "Drift from a console change",
      level: "12",
      story: "Last night someone opened SSH on the web security group from the AWS console to debug, and never closed it.",
      goal: "Put the security group back to what the code says.",
      done: "The console change is undone.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_security_group" "web" {
            name        = "web"
            description = "HTTPS from the internet"
            vpc_id      = "${VPC.id}"

            ingress {
              description = "HTTPS"
              from_port   = 443
              to_port     = 443
              protocol    = "tcp"
              cidr_blocks = ["0.0.0.0/0"]
            }

            egress {
              from_port   = 0
              to_port     = 0
              protocol    = "-1"
              cidr_blocks = ["0.0.0.0/0"]
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [VPC],
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        const sg = w.cloudGet("aws_security_group", w.state.resources["aws_security_group.web"].id);
        sg.attrs.ingress = [...sg.attrs.ingress, { description: "debug ssh", from_port: 22, to_port: 22, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] }];
      },
      won: (w) => { const r = w.state.resources["aws_security_group.web"]; const o = r && w.cloudGet(r.type, r.id); return Boolean(o) && !o.attrs.ingress.some((x) => x.from_port === 22) && same(o.attrs, r.attrs); },
      check: (w) => { const r = w.state.resources["aws_security_group.web"]; const o = r && w.cloudGet(r.type, r.id); const open = o && o.attrs.ingress.some((x) => x.from_port === 22); return { label: "SSH from 0.0.0.0/0", ok: Boolean(o) && !open, text: open ? "open" : "closed" }; },
      hints: [
        "terraform plan. Read the note about objects that changed outside of Terraform.",
        "Terraform refreshes first, sees the extra ingress rule, then plans to remove it because the code does not have it. apply -refresh-only would do the opposite: accept the drift into state.",
        "terraform apply and answer yes. Then terraform plan should say No changes."
      ],
      lesson: "A plan compares code, state and the real world. Applying the code undoes console changes; -refresh-only only records them. Make the console read-only for people and let changes go through code.",
      tries: ["terraform plan", "aws ec2 describe-security-groups"]
    },
    {
      id: "import",
      title: "Importing an existing bucket",
      level: "08",
      story: "The assets bucket was created by hand years ago and holds 1,240 files. Now it is in the code, but apply fails.",
      goal: "Bring the existing bucket quest-assets-2026 under Terraform without creating another.",
      done: "Terraform manages the existing bucket.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "assets" {
            bucket = "quest-assets-2026"

            tags = {
              Team = "web"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [{ type: "aws_s3_bucket", id: "quest-assets-2026", attrs: { bucket: "quest-assets-2026", arn: "arn:aws:s3:::quest-assets-2026", region: REGION, tags: { Team: "web" } }, extra: { objects: 1240, region: REGION } }],
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => { const r = w.state.resources["aws_s3_bucket.assets"]; return Boolean(r) && r.id === "quest-assets-2026" && w.cloudAll("aws_s3_bucket").length === 1; },
      check: (w) => { const r = w.state.resources["aws_s3_bucket.assets"]; return { label: "quest-assets-2026", ok: Boolean(r) && r.id === "quest-assets-2026", text: r && r.id === "quest-assets-2026" ? "managed" : w.cloudAll("aws_s3_bucket").length > 1 ? "a second bucket was created" : "not in state" }; },
      hints: [
        "terraform apply. What does AWS say about the bucket name?",
        "The bucket exists, but the state has no record of it, so Terraform tries to create it. Tell Terraform the object already exists.",
        "terraform import aws_s3_bucket.assets quest-assets-2026 (or add an import block with to and id), then terraform plan should show no changes."
      ],
      lesson: "Import connects an existing object to a resource address. Renaming the bucket in code only creates a second, empty bucket. An import block lets you review the import in a plan first.",
      tries: ["terraform apply", "aws s3 ls"]
    },
    {
      id: "removed",
      title: "Stop managing without destroying",
      level: "11",
      story: "The data team now owns the 2019 archive bucket in their own repository. Your configuration must let go of it, and it holds 48,210 files.",
      goal: "Remove quest-archive-2019 from this configuration and its state, and keep the bucket.",
      done: "Terraform no longer manages the archive; the bucket survives.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "site" {
            bucket = "quest-site-2026"
          }

          resource "aws_s3_bucket" "archive" {
            bucket        = "quest-archive-2019"
            force_destroy = true
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => { quietly(w, "terraform init", "terraform apply -auto-approve"); w.cloudGet("aws_s3_bucket", "quest-archive-2019").extra.objects = 48210; },
      won: (w) => live(w, "aws_s3_bucket", "quest-archive-2019") && !inState(w, "aws_s3_bucket.archive") && !/"archive"\s*\{/.test(w.fs["main.tf"] || "") && cleanPlan(w),
      check: (w) => ({ label: "Archive bucket", ok: live(w, "aws_s3_bucket", "quest-archive-2019") && !inState(w, "aws_s3_bucket.archive"), text: !live(w, "aws_s3_bucket", "quest-archive-2019") ? "deleted, 48,210 files lost" : inState(w, "aws_s3_bucket.archive") ? "still managed here" : "handed over" }),
      hints: [
        "If you only delete the resource block, what does terraform plan say it will do to the bucket?",
        "Two ways to forget an object without destroying it: terraform state rm, or a removed block with lifecycle { destroy = false }, which shows up in a plan for review.",
        "Replace the archive block with: removed { from = aws_s3_bucket.archive  lifecycle { destroy = false } } (each on its own line), then terraform apply."
      ],
      lesson: "Deleting a block means destroy. To hand an object over, remove it from state with a removed block (reviewable) or terraform state rm, and watch out for force_destroy, which lets a destroy empty a bucket.",
      tries: ["terraform state list", "cat main.tf"]
    },
    {
      id: "moved",
      title: "Moved block after a rename",
      level: "11",
      story: "A refactoring pull request renamed aws_instance.web to aws_instance.app. The plan wants to destroy the running server and build a new one.",
      goal: "Keep the same server under its new name, with no replacement.",
      done: "The server kept its ID under the new name.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_instance" "web" {
            ami           = "${AMI}"
            instance_type = "t3.small"

            tags = {
              Name = "shop-app"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.memo.id = w.state.resources["aws_instance.web"].id;
        w.fs["main.tf"] = w.fs["main.tf"].replace('"web"', '"app"');
      },
      won: (w) => { const r = w.state.resources["aws_instance.app"]; return Boolean(r) && r.id === w.memo.id && !inState(w, "aws_instance.web") && live(w, "aws_instance", w.memo.id); },
      check: (w) => { const r = w.state.resources["aws_instance.app"] || w.state.resources["aws_instance.web"]; return { label: "Server", ok: Boolean(r) && r.id === w.memo.id && r.addr === "aws_instance.app", text: !live(w, "aws_instance", w.memo.id) ? "replaced: new server, old one gone" : r && r.addr === "aws_instance.app" ? `${w.memo.id} as app` : `${w.memo.id} as web` }; },
      hints: [
        "terraform plan: one destroy and one create. Terraform tracks objects by address, and the address changed.",
        "Tell Terraform the object moved: a moved block in the code (reviewed with the change), or terraform state mv from your terminal.",
        "Add to main.tf: moved { from = aws_instance.web  to = aws_instance.app } (on separate lines), then terraform plan shows the move and 0 to destroy; terraform apply."
      ],
      lesson: "Renaming a resource or moving it into a module changes its address. A moved block records the rename in code, so every workspace and every teammate's state follows it.",
      tries: ["terraform plan", "terraform state list"]
    },
    {
      id: "taint",
      title: "Replace a broken instance",
      level: "05",
      story: "The api server's bootstrap ran during a package mirror outage. AWS marks it impaired, but the configuration is fine, so terraform plan sees nothing to do.",
      goal: "Replace the api instance with a fresh one.",
      done: "A healthy new api instance is running.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_instance" "api" {
            ami           = "${AMI}"
            instance_type = "t3.small"
            user_data     = file("bootstrap.sh")

            tags = {
              Name = "api"
            }
          }
        `),
        "bootstrap.sh": "#!/bin/sh\nset -eu\ndnf install -y nginx\nsystemctl enable --now nginx\n",
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.memo.id = w.state.resources["aws_instance.api"].id;
        w.cloudGet("aws_instance", w.memo.id).extra.impaired = true;
      },
      won: (w) => { const r = w.state.resources["aws_instance.api"]; const o = r && w.cloudGet(r.type, r.id); return Boolean(o) && r.id !== w.memo.id && !o.extra.impaired; },
      check: (w) => { const r = w.state.resources["aws_instance.api"]; const o = r && w.cloudGet(r.type, r.id); return { label: "api status check", ok: Boolean(o) && !o.extra.impaired, text: o ? (o.extra.impaired ? "impaired" : "ok") : "no instance" }; },
      hints: [
        "aws ec2 describe-instance-status shows the problem; terraform plan does not, because nothing in the configuration changed.",
        "Ask Terraform to replace one object on purpose. terraform taint still works but is deprecated; -replace shows the replacement in the plan first.",
        "terraform apply -replace=aws_instance.api and answer yes."
      ],
      lesson: "-replace=ADDRESS plans a destroy-and-create for one object you know is broken. Use it instead of taint, and never delete the object by hand to force it.",
      tries: ["aws ec2 describe-instance-status", "terraform plan"]
    },
    {
      id: "dbreplace",
      title: "A rename that replaces the database",
      level: "06",
      story: "A naming-standards pull request renamed the orders database from orders-db to orders-db-prod and added an Owner tag. The plan says the database must be replaced.",
      goal: "Ship the Owner tag without replacing the database, and protect it from being destroyed.",
      done: "Tag added, same database, protected.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_db_instance" "orders" {
            identifier                  = "orders-db"
            engine                      = "postgres"
            engine_version              = "16.4"
            instance_class              = "db.t4g.medium"
            allocated_storage           = 100
            username                    = "orders"
            manage_master_user_password = true
            skip_final_snapshot         = true

            tags = {
              Team = "orders"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.memo.id = w.state.resources["aws_db_instance.orders"].id;
        w.cloudGet("aws_db_instance", w.memo.id).extra.objects = 1;
        w.fs["main.tf"] = w.fs["main.tf"].replace('"orders-db"', '"orders-db-prod"').replace('Team = "orders"', 'Team  = "orders"\n    Owner = "platform"');
      },
      won: (w) => { const o = w.cloudGet("aws_db_instance", w.memo.id); return Boolean(o) && (o.attrs.tags || {}).Owner === "platform" && !w.lost.length && /prevent_destroy\s*=\s*true/.test(w.fs["main.tf"] || ""); },
      check: (w) => { const o = w.cloudGet("aws_db_instance", w.memo.id); return { label: "orders database", ok: Boolean(o) && !w.lost.length, text: w.lost.length ? "replaced: data lost" : o && (o.attrs.tags || {}).Owner === "platform" ? "tagged, same instance" : "same instance, tag not applied" }; },
      hints: [
        "terraform plan. Find the line marked # forces replacement: which argument causes it?",
        "An RDS identifier cannot change in place, so Terraform destroys and recreates, and skip_final_snapshot = true means no snapshot either. create_before_destroy would not save the data.",
        "Set identifier back to \"orders-db\", add lifecycle { prevent_destroy = true } inside the resource, then terraform apply. The plan should show 1 to change."
      ],
      lesson: "Read every -/+ and # forces replacement before applying. prevent_destroy makes Terraform refuse any plan that would destroy the object, and deletion_protection does the same on the AWS side.",
      tries: ["terraform plan", "aws rds describe-db-instances"]
    },
    {
      id: "cbd",
      title: "DependencyViolation on replace",
      level: "06",
      story: "Changing the web security group's description forces a replacement. Apply sits for minutes deleting the old group, then fails: an instance still uses it.",
      goal: "Ship the new description with an apply that succeeds.",
      done: "New security group in place; the old one removed after.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_security_group" "web" {
            name        = "web"
            description = "HTTPS from the load balancer"
            vpc_id      = "${VPC.id}"

            ingress {
              from_port   = 443
              to_port     = 443
              protocol    = "tcp"
              cidr_blocks = ["10.0.0.0/16"]
            }
          }

          resource "aws_instance" "web" {
            ami                    = "${AMI}"
            instance_type          = "t3.small"
            vpc_security_group_ids = [aws_security_group.web.id]
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [VPC],
      setup: (w) => {
        w.fs["main.tf"] = w.fs["main.tf"].replace("HTTPS from the load balancer", "HTTPS");
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["main.tf"] = w.fs["main.tf"].replace('description = "HTTPS"', 'description = "HTTPS from the load balancer"');
      },
      won: (w) => { const sg = w.state.resources["aws_security_group.web"]; const i = w.state.resources["aws_instance.web"]; const o = sg && w.cloudGet(sg.type, sg.id); return Boolean(o) && o.attrs.description === "HTTPS from the load balancer" && Boolean(i) && attrOf(w, "aws_instance.web", "vpc_security_group_ids").includes(sg.id) && w.cloudAll("aws_security_group").length === 1; },
      check: (w) => { const sg = w.state.resources["aws_security_group.web"]; const o = sg && w.cloudGet(sg.type, sg.id); return { label: "web security group", ok: Boolean(o) && o.attrs.description === "HTTPS from the load balancer", text: o ? `"${o.attrs.description}"` : "missing from state" }; },
      hints: [
        "terraform apply. Which object does AWS refuse to delete, and what still uses it?",
        "Terraform destroys first and creates after, unless told otherwise. Creating first needs a name that does not clash with the old group: name_prefix instead of name.",
        "In the security group: replace name = \"web\" with name_prefix = \"web-\" and add lifecycle { create_before_destroy = true }. Then terraform apply."
      ],
      lesson: "create_before_destroy makes the replacement exist before the old object goes, so dependants can switch over. Objects with unique names need name_prefix, or the create fails with a duplicate.",
      tries: ["terraform plan", "terraform apply"]
    },
    {
      id: "countshift",
      title: "count deletes the wrong runner",
      level: "07",
      story: "Alice left the team, so you removed her from the runners list. The plan renames Bob's runner to Alice's slot and destroys Carol's.",
      goal: "Remove only Alice's runner; Bob's and Carol's must not be touched.",
      done: "Only Alice's runner was removed.",
      files: {
        "versions.tf": versions(),
        "variables.tf": hcl(`
          variable "teams" {
            description = "One CI runner per person"
            type        = list(string)
            default     = ["alice", "bob", "carol"]
          }
        `),
        "main.tf": hcl(`
          resource "aws_instance" "runner" {
            count         = length(var.teams)
            ami           = "${AMI}"
            instance_type = "t3.medium"

            tags = {
              Name = "ci-runner-\${var.teams[count.index]}"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        ["alice", "bob", "carol"].forEach((n, i) => { w.memo[n] = w.state.resources[`aws_instance.runner[${i}]`].id; });
        w.fs["variables.tf"] = w.fs["variables.tf"].replace('["alice", "bob", "carol"]', '["bob", "carol"]');
      },
      won: (w) => !live(w, "aws_instance", w.memo.alice) && ["bob", "carol"].every((n) => { const o = w.cloudGet("aws_instance", w.memo[n]); return o && o.attrs.tags.Name === `ci-runner-${n}`; }) && Object.keys(w.state.resources).some((a) => a.includes('["bob"]')),
      check: (w) => { const ok = ["bob", "carol"].filter((n) => { const o = w.cloudGet("aws_instance", w.memo[n]); return o && o.attrs.tags.Name === `ci-runner-${n}`; }); return { label: "Bob and Carol", ok: ok.length === 2, text: ok.length === 2 ? (live(w, "aws_instance", w.memo.alice) ? "untouched; Alice still running" : "untouched") : "a runner was renamed or destroyed" }; },
      hints: [
        "terraform plan. With count, instances are numbered: removing the first name shifts every index after it.",
        "for_each keys instances by name instead of position. The state still has [0], [1], [2], so tell Terraform which index is which name.",
        "Use for_each = toset(var.teams) and Name = \"ci-runner-${each.key}\", add moved blocks from aws_instance.runner[1] to aws_instance.runner[\"bob\"] and [2] to [\"carol\"], then terraform apply: only [0] is destroyed."
      ],
      lesson: "count is for identical copies. For things with an identity (people, environments, buckets) use for_each with stable keys, and move existing state with moved blocks or terraform state mv when you switch.",
      tries: ["terraform plan", "terraform state list"]
    },
    {
      id: "target",
      title: "-target left changes behind",
      level: "14",
      story: "Yesterday's hotfix resized the app server and moved it to port 8443. To ship fast it was applied with -target=aws_instance.app. Health checks on 8443 have failed since.",
      goal: "Apply everything in the configuration and get a clean plan.",
      done: "Configuration fully applied.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_security_group" "app" {
            name        = "app"
            description = "App traffic from the load balancer"
            vpc_id      = "${VPC.id}"
          }

          resource "aws_vpc_security_group_ingress_rule" "app_https" {
            security_group_id = aws_security_group.app.id
            ip_protocol       = "tcp"
            from_port         = 8443
            to_port           = 8443
            cidr_ipv4         = "10.0.0.0/16"
          }

          resource "aws_instance" "app" {
            ami                    = "${AMI}"
            instance_type          = "t3.medium"
            vpc_security_group_ids = [aws_security_group.app.id]
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [VPC],
      setup: (w) => {
        const final = w.fs["main.tf"];
        w.fs["main.tf"] = final.replace(/8443/g, "8080").replace("t3.medium", "t3.small");
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["main.tf"] = final;
        quietly(w, "terraform apply -auto-approve -target=aws_instance.app");
        w.lastPlan = null;
      },
      won: (w) => attrOf(w, "aws_vpc_security_group_ingress_rule.app_https", "from_port") === 8443 && cleanPlan(w),
      check: (w) => { const p = attrOf(w, "aws_vpc_security_group_ingress_rule.app_https", "from_port"); return { label: "app security group allows", ok: p === 8443, text: p ? `port ${p}` : "nothing" }; },
      hints: [
        "terraform plan, with no -target. What is still waiting to be applied?",
        "-target applies the named resource and what it depends on. The ingress rule depends on the security group, not on the instance, so its change in the same commit was skipped. The warning said so.",
        "terraform apply (no -target) and answer yes, then terraform plan to confirm No changes."
      ],
      lesson: "-target is for recovering from mistakes, not for shipping. Anything outside the target silently waits, and the next person's plan inherits it. Apply the whole configuration and keep plans clean.",
      tries: ["terraform plan", "aws ec2 describe-security-groups"]
    },
    {
      id: "ignorechanges",
      title: "Every apply resets the autoscaler",
      level: "12",
      story: "The web Auto Scaling group scales on CPU and runs 6 instances at peak. Each terraform apply puts it back to 2, and the last one caused an outage.",
      goal: "Make the plan show no changes while the autoscaler keeps managing capacity (6 now).",
      done: "Terraform leaves desired capacity to the autoscaler.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_autoscaling_group" "web" {
            name                = "web"
            min_size            = 2
            max_size            = 10
            desired_capacity    = 2
            vpc_zone_identifier = ["subnet-0d1e2f3a4b5c6d7e8", "subnet-0e2f3a4b5c6d7e8f9"]

            launch_template {
              name    = "web"
              version = "$Latest"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => { quietly(w, "terraform init", "terraform apply -auto-approve"); w.cloudGet("aws_autoscaling_group", "web").attrs.desired_capacity = 6; },
      won: (w) => { const o = w.cloudGet("aws_autoscaling_group", "web"); return Boolean(o) && o.attrs.desired_capacity === 6 && cleanPlan(w) && /ignore_changes\s*=\s*\[[^\]]*desired_capacity|^(?![\s\S]*desired_capacity)/.test(w.fs["main.tf"] || ""); },
      check: (w) => { const o = w.cloudGet("aws_autoscaling_group", "web"); const n = o && o.attrs.desired_capacity; return { label: "Desired capacity", ok: n === 6, text: n === 6 ? "6 (autoscaler)" : `${n}: reset by Terraform` }; },
      hints: [
        "terraform plan. Who changed desired_capacity outside Terraform, and what will apply do?",
        "Two owners for one value means a tug of war. Let Terraform set min and max, and tell it to leave desired_capacity alone. Hard-coding 6 only moves the problem.",
        "Add lifecycle { ignore_changes = [desired_capacity] } to the group, then terraform plan should say No changes."
      ],
      lesson: "ignore_changes hands one attribute to something else (an autoscaler, a deploy tool). apply -refresh-only only records today's value; the next plan still fights it.",
      tries: ["terraform plan", "aws autoscaling describe-auto-scaling-groups"]
    },
    {
      id: "cycle",
      title: "Dependency cycle",
      level: "03",
      story: "The app may talk to the database on 5432 and nothing else. The two security groups each reference the other, and Terraform refuses to plan.",
      goal: "Create both groups with app to db on 5432 allowed both ways (app egress, db ingress).",
      done: "Both groups exist and the rule pair is in place.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_security_group" "app" {
            name   = "app"
            vpc_id = "${VPC.id}"

            egress {
              from_port       = 5432
              to_port         = 5432
              protocol        = "tcp"
              security_groups = [aws_security_group.db.id]
            }
          }

          resource "aws_security_group" "db" {
            name   = "db"
            vpc_id = "${VPC.id}"

            ingress {
              from_port       = 5432
              to_port         = 5432
              protocol        = "tcp"
              security_groups = [aws_security_group.app.id]
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [VPC],
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => {
        const app = w.cloudAll("aws_security_group").find((o) => o.attrs.name === "app");
        const db = w.cloudAll("aws_security_group").find((o) => o.attrs.name === "db");
        if (!app || !db) return false;
        const rules = (dir, sg) => [...(sg.attrs[dir] || []).map((r) => ({ port: r.from_port, to: r.to_port, peers: r.security_groups || [], proto: r.protocol })),
          ...w.cloudAll(`aws_vpc_security_group_${dir}_rule`).filter((r) => r.attrs.security_group_id === sg.id).map((r) => ({ port: r.attrs.from_port, to: r.attrs.to_port, peers: [r.attrs.referenced_security_group_id], proto: r.attrs.ip_protocol }))];
        const covers = (r, peer) => (r.proto === "-1" || (r.port <= 5432 && r.to >= 5432)) && r.peers.includes(peer);
        return rules("ingress", db).some((r) => covers(r, app.id)) && rules("egress", app).some((r) => covers(r, db.id));
      },
      check: (w) => { const n = w.cloudAll("aws_security_group").length; return { label: "Security groups", ok: n === 2, text: `${n} of 2 created` }; },
      hints: [
        "terraform plan prints the cycle. Each group's inline rule needs the other group's ID before it can be created.",
        "Create the two groups without rules that point at each other, then attach the rules as separate resources that reference both IDs. depends_on only adds edges; it cannot break a cycle.",
        "Remove the egress block from app and the ingress block from db. Add aws_vpc_security_group_egress_rule (security_group_id = app, referenced_security_group_id = db) and aws_vpc_security_group_ingress_rule (security_group_id = db, referenced_security_group_id = app), each with ip_protocol = \"tcp\", from_port and to_port 5432. Then terraform apply."
      ],
      lesson: "Terraform builds a graph from references; a cycle has no valid order. Separate rule resources (aws_vpc_security_group_ingress_rule / egress_rule) break security group cycles and are easier to review than inline blocks.",
      tries: ["terraform plan", "terraform graph"]
    },
    {
      id: "teardown",
      title: "Destroy stops at the database",
      level: "06",
      story: "The load-test environment is done and costs money every hour. terraform destroy removed half of it, then stopped at the database.",
      goal: "Tear the whole load-test environment down.",
      done: "Everything is destroyed.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_db_instance" "loadtest" {
            identifier                  = "loadtest-db"
            engine                      = "postgres"
            instance_class              = "db.r6g.xlarge"
            allocated_storage           = 500
            username                    = "loadtest"
            manage_master_user_password = true
            skip_final_snapshot         = true
            deletion_protection         = true
          }

          resource "aws_instance" "load" {
            ami           = "${AMI}"
            instance_type = "c6i.4xlarge"
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => { quietly(w, "terraform init", "terraform apply -auto-approve"); w.memo.db = w.state.resources["aws_db_instance.loadtest"].id; },
      won: (w) => !w.cloudAll("aws_db_instance").length && !w.cloudAll("aws_instance").length,
      check: (w) => { const n = w.cloudAll("aws_db_instance").length + w.cloudAll("aws_instance").length; return { label: "Still running (and billing)", ok: n === 0, text: n ? `${n} object${n === 1 ? "" : "s"}` : "nothing" }; },
      hints: [
        "terraform destroy -auto-approve. Which API error stops it, and from which setting?",
        "deletion_protection is enforced by AWS, not Terraform. Turn it off with an apply first. Removing the database from state would only hide it while it keeps billing.",
        "Set deletion_protection = false, terraform apply, then terraform destroy."
      ],
      lesson: "deletion_protection guards production databases at the AWS level. For a deliberate teardown, switch it off in code and apply before destroy. state rm never deletes anything; it just stops Terraform from seeing it.",
      tries: ["terraform destroy", "aws rds describe-db-instances"]
    },
    {
      id: "varci",
      title: "Variable not set in CI",
      level: "02",
      story: "terraform plan works on your laptop. In CI the same plan fails before it starts.",
      goal: "Make the CI plan run for the staging environment.",
      done: "CI plans staging with no changes.",
      files: {
        "versions.tf": versions("~> 5.0", S3_BACKEND()),
        "variables.tf": hcl(`
          variable "environment" {
            description = "dev, staging or prod"
            type        = string
          }
        `),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "uploads" {
            bucket = "quest-uploads-\${var.environment}"
          }
        `),
        "terraform.tfvars": 'environment = "staging"\n',
        ".github/workflows/terraform.yml": workflow(["terraform init -input=false", "terraform plan -input=false"], "\n        env:\n          AWS_REGION: eu-west-1"),
        ".gitignore": GITIGNORE
      },
      cloud: STATE_BUCKET,
      setup: (w) => quietly(w, "terraform init", "terraform apply -auto-approve"),
      won: (w) => { const r = w.ciRuns[w.ciRuns.length - 1]; return Boolean(r && r.ok && r.plan && r.plan.nothing); },
      check: (w) => { const r = w.ciRuns[w.ciRuns.length - 1]; return { label: "CI plan", ok: Boolean(r && r.ok && r.plan && r.plan.nothing), text: !r ? "not run yet" : !r.ok ? "failing" : r.plan && r.plan.nothing ? "staging, no changes" : "runs, but plans changes" }; },
      hints: [
        "ci run. Then compare: which files does the runner have that your laptop has? cat .gitignore.",
        "terraform.tfvars is ignored by git, so CI never sees it, and -input=false turns the prompt into an error. A default of \"dev\" would plan the wrong environment.",
        "Give the runner the value: add TF_VAR_environment: staging under env: in .github/workflows/terraform.yml (edit it), then ci run."
      ],
      lesson: "CI only has what is committed plus what the workflow sets. Pass non-secret values with TF_VAR_ variables or a committed -var-file, and secrets from the CI secret store.",
      tries: ["ci run", "cat .gitignore"]
    },
    {
      id: "tfvarsprec",
      title: "tfvars precedence",
      level: "02",
      story: "terraform.tfvars says t3.large, yet the plan wants to shrink the production app server to t3.micro.",
      goal: "Make the plan keep the app server on t3.large.",
      done: "The plan keeps t3.large.",
      files: {
        "versions.tf": versions(),
        "variables.tf": hcl(`
          variable "instance_type" {
            description = "Size of the app server"
            type        = string
          }
        `),
        "main.tf": hcl(`
          resource "aws_instance" "app" {
            ami           = "${AMI}"
            instance_type = var.instance_type
          }
        `),
        "terraform.tfvars": 'instance_type = "t3.large"\n',
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["dev.auto.tfvars"] = '# copied from a dev checkout\ninstance_type = "t3.micro"\n';
      },
      won: (w) => attrOf(w, "aws_instance.app", "instance_type") === "t3.large" && cleanPlan(w) && !Object.entries(w.fs).some(([f, t]) => f.endsWith(".auto.tfvars") && t.includes("t3.micro")),
      check: (w) => { const t = attrOf(w, "aws_instance.app", "instance_type"); return { label: "app server", ok: t === "t3.large", text: t }; },
      hints: [
        "ls. Which variable files does Terraform load without being told?",
        "Order, lowest first: defaults, TF_VAR_ environment variables, terraform.tfvars, *.auto.tfvars in name order, then -var and -var-file. An export loses to every file.",
        "rm dev.auto.tfvars (it was never meant for this directory), then terraform plan."
      ],
      lesson: "*.auto.tfvars files load automatically and beat terraform.tfvars. Keep one clear source per environment, and read a plan's sizes before you apply.",
      tries: ["terraform plan", "ls"]
    },
    {
      id: "modpin",
      title: "Unpinned module upgraded itself",
      level: "09",
      story: "A teammate ran terraform init -upgrade this morning. Since then every plan fails inside the vpc module call.",
      goal: "Pin the module to the 2.x line this code was written for and get a clean plan.",
      done: "Module pinned to 2.x; plan is clean.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          module "vpc" {
            source = "quest-modules/vpc/aws"

            name           = "shop"
            cidr           = "10.0.0.0/16"
            public_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
          }
        `),
        ".gitignore": GITIGNORE
      },
      registry: {
        "quest-modules/vpc/aws": {
          "2.4.1": {
            "variables.tf": hcl(`
              variable "name" {
                type = string
              }

              variable "cidr" {
                type = string
              }

              variable "public_subnets" {
                type = list(string)
              }
            `),
            "main.tf": hcl(`
              resource "aws_vpc" "this" {
                cidr_block = var.cidr

                tags = {
                  Name = var.name
                }
              }

              resource "aws_subnet" "public" {
                count      = length(var.public_subnets)
                vpc_id     = aws_vpc.this.id
                cidr_block = var.public_subnets[count.index]
              }
            `),
            "outputs.tf": 'output "vpc_id" {\n  value = aws_vpc.this.id\n}\n'
          },
          "3.0.0": {
            "variables.tf": hcl(`
              variable "name" {
                type = string
              }

              variable "cidr" {
                type = string
              }

              variable "public_subnet_cidrs" {
                type = list(string)
              }
            `),
            "main.tf": hcl(`
              resource "aws_vpc" "this" {
                cidr_block = var.cidr

                tags = {
                  Name = var.name
                }
              }

              resource "aws_subnet" "this" {
                count      = length(var.public_subnet_cidrs)
                vpc_id     = aws_vpc.this.id
                cidr_block = var.public_subnet_cidrs[count.index]
              }
            `),
            "outputs.tf": 'output "vpc_id" {\n  value = aws_vpc.this.id\n}\n'
          }
        }
      },
      setup: (w) => {
        w.fs["main.tf"] = w.fs["main.tf"].replace('source = "quest-modules/vpc/aws"', 'source  = "quest-modules/vpc/aws"\n  version = "2.4.1"');
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["main.tf"] = w.fs["main.tf"].replace('source  = "quest-modules/vpc/aws"\n  version = "2.4.1"', 'source = "quest-modules/vpc/aws"');
        quietly(w, "terraform init -upgrade");
      },
      won: (w) => { const m = w.dot && w.dot.modules.vpc; const call = (/version\s*=\s*"([^"]+)"/.exec(w.fs["main.tf"] || "") || [])[1]; return Boolean(m && m.version === "2.4.1" && call && satisfies("2.4.1", call) && !satisfies("3.0.0", call) && cleanPlan(w)); },
      check: (w) => { const m = w.dot && w.dot.modules.vpc; return { label: "vpc module", ok: Boolean(m && m.version.startsWith("2.")), text: m ? `${m.version} installed` : "not installed" }; },
      hints: [
        "terraform plan names the argument. Then cat .terraform/modules/vpc/variables.tf: which version is installed, and what changed?",
        "Without a version argument, init -upgrade takes the newest release, including a new major version with breaking changes. Renaming the input to fit 3.0 would also replace the subnets.",
        "Add version = \"~> 2.4\" to the module block, run terraform init, then terraform plan."
      ],
      lesson: "Pin registry modules (version = \"~> 2.4\") and providers the same way, and upgrade majors on purpose in their own pull request after reading the changelog.",
      tries: ["terraform plan", "cat .terraform/modules/vpc/variables.tf"]
    },
    {
      id: "modoutput",
      title: "Module output that does not exist",
      level: "09",
      story: "The app server should go in the network module's first private subnet. The plan stops at the reference.",
      goal: "Launch the app instance in the module's first private subnet.",
      done: "The app runs in the first private subnet.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          module "network" {
            source = "./modules/network"
            cidr   = "10.0.0.0/16"
          }

          resource "aws_instance" "app" {
            ami           = "${AMI}"
            instance_type = "t3.small"
            subnet_id     = module.network.subnet_id
          }
        `),
        "modules/network/variables.tf": 'variable "cidr" {\n  type = string\n}\n',
        "modules/network/main.tf": hcl(`
          resource "aws_vpc" "this" {
            cidr_block = var.cidr
          }

          resource "aws_subnet" "private" {
            count      = 2
            vpc_id     = aws_vpc.this.id
            cidr_block = cidrsubnet(var.cidr, 8, count.index + 10)
          }
        `),
        "modules/network/outputs.tf": hcl(`
          output "vpc_id" {
            value = aws_vpc.this.id
          }

          output "private_subnet_ids" {
            value = aws_subnet.private[*].id
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => { const s = w.state.resources["module.network.aws_subnet.private[0]"]; return Boolean(s) && attrOf(w, "aws_instance.app", "subnet_id") === s.id; },
      check: (w) => { const s = w.state.resources["module.network.aws_subnet.private[0]"]; const id = attrOf(w, "aws_instance.app", "subnet_id"); return { label: "app subnet", ok: Boolean(s) && id === s.id, text: id ? (s && id === s.id ? "first private subnet" : "another subnet") : "not created" }; },
      hints: [
        "terraform validate. A module only exposes what its outputs.tf declares: cat modules/network/outputs.tf.",
        "private_subnet_ids is a list. Index it, or add a new output to the module.",
        "Use subnet_id = module.network.private_subnet_ids[0], then terraform apply."
      ],
      lesson: "A module is a box with declared inputs and outputs; nothing inside is reachable unless an output exposes it. terraform console helps: try module.network after an apply.",
      tries: ["terraform validate", "cat modules/network/outputs.tf"]
    },
    {
      id: "foreachunknown",
      title: "for_each over values known after apply",
      level: "07",
      story: "One worker per private subnet, keyed by subnet ID. On a fresh environment the plan refuses to start.",
      goal: "Create one worker per private subnet with a configuration that plans from scratch in one go.",
      done: "Workers created; the configuration plans cleanly from empty.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_subnet" "private" {
            count      = 2
            vpc_id     = "${VPC.id}"
            cidr_block = "10.0.\${count.index + 10}.0/24"
          }

          resource "aws_instance" "worker" {
            for_each      = toset(aws_subnet.private[*].id)
            ami           = "${AMI}"
            instance_type = "t3.small"
            subnet_id     = each.value
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [VPC],
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => {
        const subnets = Object.values(w.state.resources).filter((r) => r.type === "aws_subnet").map((r) => r.id);
        const workers = Object.values(w.state.resources).filter((r) => r.type === "aws_instance");
        return subnets.length === 2 && workers.length === 2 && workers.every((r) => subnets.includes(r.attrs.subnet_id)) && freshPlanOk(w);
      },
      check: (w) => { const n = Object.values(w.state.resources).filter((r) => r.type === "aws_instance").length; return { label: "Workers", ok: n === 2, text: `${n} of 2` }; },
      hints: [
        "terraform plan explains the problem: the keys of for_each must be known while planning, and subnet IDs exist only after apply.",
        "Key the instances by something written in the code (a name or an AZ), and keep the apply-time ID in the value. -target works once, but the next fresh environment fails again.",
        "Use for_each = { a = 0, b = 1 } style keys: give the subnets for_each = toset([\"a\", \"b\"]) with cidr_block from a map, then for_each = aws_subnet.private on the workers with subnet_id = each.value.id. Then terraform apply."
      ],
      lesson: "for_each keys must be known at plan time. Use static keys (names, AZs) and let unknown IDs live in the values; for_each over a resource with static keys is fine.",
      tries: ["terraform plan", "cat main.tf"]
    },
    {
      id: "datanotfound",
      title: "Data source not found",
      level: "08",
      story: "The staging security group looks up its VPC by tag. The plan stops with an error from the data source.",
      goal: "Create the staging app security group in the staging VPC.",
      done: "The group is in the staging VPC.",
      files: {
        "versions.tf": versions(),
        "variables.tf": 'variable "environment" {\n  type    = string\n  default = "staging"\n}\n',
        "main.tf": hcl(`
          data "aws_vpc" "main" {
            tags = {
              Name = "shop-\${var.environment}"
            }
          }

          resource "aws_security_group" "app" {
            name   = "app-\${var.environment}"
            vpc_id = data.aws_vpc.main.id
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [
        { type: "aws_vpc", id: "vpc-0b2c3d4e5f6071829", attrs: { cidr_block: "10.1.0.0/16", tags: { Name: "shop-vpc-staging", Environment: "staging" } } },
        { type: "aws_vpc", id: "vpc-0c3d4e5f60718293a", attrs: { cidr_block: "10.2.0.0/16", tags: { Name: "shop-vpc-prod", Environment: "prod" } } }
      ],
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => attrOf(w, "aws_security_group.app", "vpc_id") === "vpc-0b2c3d4e5f6071829",
      check: (w) => { const v = attrOf(w, "aws_security_group.app", "vpc_id"); return { label: "app group VPC", ok: v === "vpc-0b2c3d4e5f6071829", text: v ? (v === "vpc-0b2c3d4e5f6071829" ? "staging" : "prod") : "not created" }; },
      hints: [
        "aws ec2 describe-vpcs. What are the VPCs really tagged?",
        "A data source must match exactly one object. Removing the filter matches two; hard-coding an ID ties the code to one account.",
        "Change the filter to Name = \"shop-vpc-${var.environment}\" (or Environment = var.environment), then terraform apply."
      ],
      lesson: "Data sources read what exists; a filter that matches nothing, or more than one thing, fails the plan. Check the real tags first, and prefer tags you control in code.",
      tries: ["terraform plan", "aws ec2 describe-vpcs"]
    },
    {
      id: "dependson",
      title: "depends_on replaces the app server",
      level: "09",
      story: "A one-line tag change on the network module. The plan also wants to replace the app server, because its AMI is suddenly known after apply.",
      goal: "Ship the network tag without replacing the app server.",
      done: "Tag shipped; app server untouched.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          module "network" {
            source = "./modules/network"
            owner  = "network-team"
          }

          module "app" {
            source     = "./modules/app"
            subnet_id  = module.network.subnet_id
            depends_on = [module.network]
          }
        `),
        "modules/network/main.tf": hcl(`
          variable "owner" {
            type = string
          }

          resource "aws_vpc" "this" {
            cidr_block = "10.0.0.0/16"

            tags = {
              Owner = var.owner
            }
          }

          resource "aws_subnet" "app" {
            vpc_id     = aws_vpc.this.id
            cidr_block = "10.0.1.0/24"
          }

          output "subnet_id" {
            value = aws_subnet.app.id
          }
        `),
        "modules/app/main.tf": hcl(`
          variable "subnet_id" {
            type = string
          }

          data "aws_ami" "base" {
            most_recent = true
            owners      = ["amazon"]
          }

          resource "aws_instance" "this" {
            ami           = data.aws_ami.base.id
            instance_type = "t3.small"
            subnet_id     = var.subnet_id
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.memo.id = w.state.resources["module.app.aws_instance.this"].id;
        w.fs["main.tf"] = w.fs["main.tf"].replace('"network-team"', '"platform"');
      },
      won: (w) => { const v = Object.values(w.state.resources).find((r) => r.type === "aws_vpc"); const o = v && w.cloudGet(v.type, v.id); return Boolean(o) && o.attrs.tags.Owner === "platform" && live(w, "aws_instance", w.memo.id) && !/depends_on/.test(w.fs["main.tf"] || ""); },
      check: (w) => ({ label: "app server", ok: live(w, "aws_instance", w.memo.id), text: live(w, "aws_instance", w.memo.id) ? "untouched" : "replaced" }),
      hints: [
        "terraform plan. Why is data.aws_ami.base read during apply?",
        "depends_on on a module makes everything inside it wait for every change in the other module, including data sources, so their results become unknown. The subnet_id input already creates the real dependency.",
        "Remove depends_on = [module.network] from module \"app\", then terraform plan shows only the tag change; terraform apply."
      ],
      lesson: "Prefer references to depends_on: they create exact dependencies. Module-level depends_on defers data sources and can turn a harmless change into replacements.",
      tries: ["terraform plan", "cat main.tf"]
    },
    {
      id: "instancekey",
      title: "Missing resource instance key",
      level: "07",
      story: "The bastion host became optional with count = var.bastion ? 1 : 0. Now the output that prints its address breaks the plan.",
      goal: "Keep the bastion optional and make the output work (empty when there is no bastion).",
      done: "The output works with or without a bastion.",
      files: {
        "versions.tf": versions(),
        "variables.tf": 'variable "bastion" {\n  type    = bool\n  default = true\n}\n',
        "main.tf": hcl(`
          resource "aws_instance" "bastion" {
            count         = var.bastion ? 1 : 0
            ami           = "${AMI}"
            instance_type = "t3.micro"
          }
        `),
        "outputs.tf": 'output "bastion_ip" {\n  value = aws_instance.bastion.private_ip\n}\n',
        ".gitignore": GITIGNORE
      },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => Boolean(w.state.outputs.bastion_ip) && /count\s*=\s*var\.bastion/.test(w.fs["main.tf"] || "") && freshPlanOk(w, ["-var", "bastion=false"]),
      check: (w) => ({ label: "bastion_ip output", ok: Boolean(w.state.outputs.bastion_ip), text: w.state.outputs.bastion_ip ? String(w.state.outputs.bastion_ip.value) : "not set" }),
      hints: [
        "terraform validate. With count set, aws_instance.bastion is a list, even when it has one element.",
        "Index [0] works only while the bastion exists; with bastion = false there is no element 0. one() returns the single element or null.",
        "Use value = one(aws_instance.bastion[*].private_ip), then terraform apply."
      ],
      lesson: "A resource with count or for_each is a collection: refer to an instance ([0], [\"key\"]) or the whole set with [*]. one() is the safe way to read an optional single resource.",
      tries: ["terraform validate", "cat outputs.tf"]
    },
    {
      id: "validation",
      title: "Invalid value for variable",
      level: "02",
      story: "The release pipeline passes environment=production. The plan stops at the variable's validation rule.",
      goal: "Plan the prod environment with a value the rule accepts.",
      done: "Planned prod.",
      files: {
        "versions.tf": versions(),
        "variables.tf": hcl(`
          variable "environment" {
            description = "Where this runs"
            type        = string

            validation {
              condition     = contains(["dev", "staging", "prod"], var.environment)
              error_message = "environment must be dev, staging or prod."
            }
          }
        `),
        "main.tf": 'resource "aws_s3_bucket" "logs" {\n  bucket = "quest-logs-${var.environment}"\n}\n',
        ".gitignore": GITIGNORE
      },
      env: { TF_VAR_environment: "production" },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => Boolean(w.lastPlan && w.lastPlan.changes.some((c) => c.addr === "aws_s3_bucket.logs")) && /\["dev", "staging", "prod"\]/.test(w.fs["variables.tf"] || "") && w.lastPlan.vars.environment === "prod",
      check: (w) => { const v = w.lastPlan && w.lastPlan.vars.environment; return { label: "environment", ok: v === "prod", text: v || "no successful plan" }; },
      hints: [
        "terraform plan, then env | grep TF_VAR. Where does the value come from?",
        "The rule is there to stop typos like production becoming a fourth environment. Widening the rule only hides the problem.",
        "export TF_VAR_environment=prod (or terraform plan -var environment=prod), then terraform plan."
      ],
      lesson: "validation blocks turn bad input into a clear error before anything is planned. Fix the caller, not the rule.",
      tries: ["terraform plan", "env"]
    },
    {
      id: "provconflict",
      title: "Provider version conflict",
      level: "10",
      story: "You added the team's storage module. terraform init now fails: no provider version satisfies everyone.",
      goal: "Get terraform init to succeed and plan the storage module.",
      done: "init succeeds and the module plans.",
      files: {
        "versions.tf": versions("~> 5.0"),
        "main.tf": hcl(`
          module "storage" {
            source = "quest-modules/storage/aws"
            name   = "shop-media"
          }
        `),
        ".gitignore": GITIGNORE
      },
      registry: {
        "quest-modules/storage/aws": Object.fromEntries([["1.3.0", ">= 5.0"], ["2.0.0", ">= 6.0"]].map(([v, c]) => [v, {
          "main.tf": hcl(`
            terraform {
              required_providers {
                aws = {
                  source  = "hashicorp/aws"
                  version = "${c}"
                }
              }
            }

            variable "name" {
              type = string
            }

            resource "aws_s3_bucket" "this" {
              bucket = var.name
            }
          `)
        }]))
      },
      won: (w) => Boolean(w.dot && w.dot.providers.aws && w.lastPlan && w.lastPlan.changes.some((c) => c.addr === "module.storage.aws_s3_bucket.this")),
      check: (w) => ({ label: "terraform init", ok: Boolean(w.dot && w.dot.providers.aws), text: w.dot && w.dot.providers.aws ? `aws ${w.dot.providers.aws}` : "not initialised" }),
      hints: [
        "terraform init, then terraform providers: which module asks for what?",
        "The root allows ~> 5.0 (5.x only) and the newest module release needs >= 6.0. init -upgrade cannot pick a version that does not exist. Choose: pin the module to its 1.x line, or move the root to provider 6.",
        "Add version = \"~> 1.3\" to the module block, then terraform init and terraform plan. (Or raise the root to version = \"~> 6.0\" in its own reviewed change.)"
      ],
      lesson: "Every module adds its provider constraints to yours, and Terraform must find one version that meets them all. terraform providers shows the tree; pin modules so their constraints change only when you choose.",
      tries: ["terraform init", "terraform providers"]
    },
    {
      id: "lockedversion",
      title: "Lock file pins an old provider",
      level: "10",
      story: "You need a newer AWS provider and raised the constraint to ~> 5.80. Now plan and init both refuse.",
      goal: "Move to a provider version that matches ~> 5.80 and plan.",
      done: "Lock file updated; plan works.",
      files: {
        "versions.tf": versions("~> 5.80"),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        const want = w.fs["versions.tf"];
        w.fs["versions.tf"] = want.replace("~> 5.80", "5.31.0");
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["versions.tf"] = want;
      },
      won: (w) => readLock(w).aws && readLock(w).aws.version === "5.80.0" && Boolean(w.lastPlan),
      check: (w) => { const l = readLock(w).aws; return { label: "Locked aws provider", ok: Boolean(l) && satisfies(l.version, "~> 5.80"), text: l ? l.version : "no lock entry" }; },
      hints: [
        "terraform init. What does it say about the locked version, and which flag does it name?",
        "The lock file keeps everyone on the same version until someone upgrades on purpose. Deleting .terraform does not touch it.",
        "terraform init -upgrade, review the .terraform.lock.hcl change, then terraform plan."
      ],
      lesson: ".terraform.lock.hcl records the exact provider version. terraform init reuses it; terraform init -upgrade picks the newest version allowed by the constraints. Commit the lock file change with the constraint change.",
      tries: ["terraform plan", "cat .terraform.lock.hcl"]
    },
    {
      id: "requiredversion",
      title: "Unsupported Terraform Core version",
      level: "10",
      story: "This old repository pins Terraform to 1.5.x. Every other repository and CI already run 1.10.5, and your laptop has 1.10.5.",
      goal: "Run a successful plan with Terraform 1.10.5.",
      done: "Planned with 1.10.5.",
      files: {
        "versions.tf": versions().replace('">= 1.5"', '"~> 1.5.0"'),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".gitignore": GITIGNORE
      },
      setup: (w) => { w.cli = "1.5.7"; quietly(w, "terraform init", "terraform apply -auto-approve"); w.cli = "1.10.5"; },
      won: (w) => Boolean(w.lastPlan && w.lastPlan.cli === "1.10.5"),
      check: (w) => ({ label: "Terraform", ok: w.cli === "1.10.5" && Boolean(w.lastPlan && w.lastPlan.cli === "1.10.5"), text: `v${w.cli}` }),
      hints: [
        "terraform plan. Which constraint, in which file?",
        "\"~> 1.5.0\" means 1.5.x only. Switching your laptop back to 1.5 with tfenv would work today and leave the repository behind everyone else.",
        "Change required_version in versions.tf to \">= 1.10, < 2.0\" (or \"~> 1.10\"), then terraform plan."
      ],
      lesson: "required_version protects state from older or untested CLIs. Constrain it to a range you test (\"~> 1.10\"), and upgrade it deliberately, together with CI.",
      tries: ["terraform plan", "terraform version"]
    },
    {
      id: "newerstate",
      title: "State written by a newer Terraform",
      level: "10",
      story: "CI moved to Terraform 1.10.5 last week and applied. Your laptop still has 1.9.8, and now nothing reads the shared state.",
      goal: "Run a plan against the shared state.",
      done: "Planned against the shared state.",
      files: {
        "versions.tf": versions("~> 5.0", S3_BACKEND()),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".gitignore": GITIGNORE
      },
      cloud: STATE_BUCKET,
      cli: "1.9.8",
      setup: (w) => { w.cli = "1.10.5"; quietly(w, "terraform init", "terraform apply -auto-approve"); w.cli = "1.9.8"; w.installed = new Set(["1.9.8"]); },
      won: (w) => Boolean(w.lastPlan) && vcmp(w.cli, "1.10.5") >= 0,
      check: (w) => ({ label: "Your Terraform", ok: vcmp(w.cli, "1.10.5") >= 0, text: `v${w.cli} (state: v1.10.5)` }),
      hints: [
        "terraform plan. The error names both versions.",
        "State written by a newer CLI may use features an older one cannot read, so Terraform refuses rather than risk damage. Provider upgrades do not help; this is the CLI itself.",
        "tfenv install 1.10.5, tfenv use 1.10.5, then terraform plan."
      ],
      lesson: "Keep one Terraform version per repository for people and CI (a .terraform-version file for tfenv, terraform_version in setup-terraform), and upgrade both together.",
      tries: ["terraform plan", "tfenv list"]
    },
    {
      id: "platformlock",
      title: "Lock file checksums for one platform",
      level: "10",
      story: "Provider downloads go through the company's network mirror, so terraform init records checksums only for the machine it runs on. Your Mac wrote the lock file; Linux CI now fails at init.",
      goal: "Make CI pass, keeping the lock file committed.",
      done: "The lock file covers both platforms; CI passes.",
      mirror: true,
      files: {
        "versions.tf": versions("~> 5.0", S3_BACKEND()),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".github/workflows/terraform.yml": workflow(["terraform init -input=false", "terraform plan -input=false"]),
        ".gitignore": GITIGNORE
      },
      cloud: STATE_BUCKET,
      setup: (w) => quietly(w, "terraform init", "terraform apply -auto-approve"),
      won: (w) => { const r = w.ciRuns[w.ciRuns.length - 1]; const l = readLock(w).aws; return Boolean(r && r.ok && l && hasHash(l, RUNNER) && !w.ignored(".terraform.lock.hcl")); },
      check: (w) => { const l = readLock(w).aws; return { label: "Lock file checksums", ok: Boolean(l && hasHash(l, RUNNER) && hasHash(l, LAPTOP)), text: l ? l.hashes.map((x) => x.split("-")[0].replace("h1:", "")).join(", ") : "no lock file" }; },
      hints: [
        "ci run, then cat .terraform.lock.hcl. Which platforms have a checksum?",
        "The runner is linux_amd64; the lock only knows darwin_arm64. Deleting or ignoring the lock file makes CI pass by giving up version pinning.",
        "terraform providers lock -platform=darwin_arm64 -platform=linux_amd64, then ci run."
      ],
      lesson: "terraform providers lock records checksums for every platform your team and CI use. Run it whenever a provider version changes, and commit the result.",
      tries: ["ci run", "cat .terraform.lock.hcl"]
    },
    {
      id: "provalias",
      title: "Certificate in the wrong region",
      level: "10",
      story: "The shop's CloudFront distribution needs its TLS certificate. Apply creates the certificate, then CloudFront rejects it.",
      goal: "Create the distribution with a certificate it accepts.",
      done: "CloudFront serves the shop with its certificate.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_acm_certificate" "shop" {
            domain_name       = "shop.example.com"
            validation_method = "DNS"
          }

          resource "aws_cloudfront_distribution" "shop" {
            enabled = true
            aliases = ["shop.example.com"]

            viewer_certificate {
              acm_certificate_arn      = aws_acm_certificate.shop.arn
              ssl_support_method       = "sni-only"
              minimum_protocol_version = "TLSv1.2_2021"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => { const d = w.cloudAll("aws_cloudfront_distribution")[0]; return Boolean(d) && d.attrs.viewer_certificate[0].acm_certificate_arn.includes(":us-east-1:"); },
      check: (w) => ({ label: "CloudFront", ok: w.cloudAll("aws_cloudfront_distribution").length > 0, text: w.cloudAll("aws_cloudfront_distribution").length ? "serving" : "not created" }),
      hints: [
        "terraform apply. Read the CloudFront error, then where the certificate was made: terraform state show aws_acm_certificate.shop.",
        "CloudFront only uses ACM certificates from us-east-1, whatever region the rest runs in. One provider block, one region; add a second, aliased provider.",
        "Add provider \"aws\" { alias = \"us_east_1\"  region = \"us-east-1\" } in versions.tf (on separate lines), add provider = aws.us_east_1 to the certificate, then terraform apply."
      ],
      lesson: "A provider configuration is one account and region. Use aliases for the exceptions (CloudFront certificates, cross-region replicas) and pass them explicitly with provider = aws.alias.",
      tries: ["terraform apply", "terraform state list"]
    },
    {
      id: "lockstuck",
      title: "State lock stuck after a crashed CI job",
      level: "13",
      story: "Last night's CI apply was killed when its runner was recycled. Since then every plan fails on the state lock.",
      goal: "Release the stale lock safely and run a normal, locked plan.",
      done: "Lock released; plans run again.",
      files: {
        "versions.tf": versions("~> 5.0", S3_BACKEND()),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".gitignore": GITIGNORE
      },
      cloud: STATE_BUCKET,
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.locks[w.storeKey()] = { id: "b7d1e9a2-5c3f-4e8b-a1d6-0f2c9e4b7a35", path: "quest-tfstate/shop/terraform.tfstate", op: "OperationTypeApply", who: "runner@fv-az1279-614", version: "1.10.5", created: "2026-10-30 02:14:09.271946 +0000 UTC" };
        w.lastPlan = null;
      },
      won: (w) => !w.locks[w.storeKey()] && Boolean(w.lastPlan && w.lastPlan.locked),
      check: (w) => { const l = w.locks[w.storeKey()]; return { label: "State lock", ok: !l, text: l ? `held by ${l.who} since 02:14` : "free" }; },
      hints: [
        "terraform plan prints the Lock Info: who holds it, since when, and its ID. Is that job still running?",
        "-lock=false skips the check but leaves the lock, and runs without protection. Release the lock itself, with the exact ID, once you are sure its owner is gone.",
        "terraform force-unlock b7d1e9a2-5c3f-4e8b-a1d6-0f2c9e4b7a35 and answer yes, then terraform plan."
      ],
      lesson: "A lock left by a killed process must be released by hand: confirm the owner is dead, then force-unlock with its ID. Never unlock while another apply may still run, and never make -lock=false a habit.",
      tries: ["terraform plan", "aws dynamodb scan --table-name tf-locks"]
    },
    {
      id: "workspace",
      title: "Wrong workspace selected",
      level: "13",
      story: "You are testing a new AMI in staging. The plan looks bigger than expected: it wants to replace three servers.",
      goal: "Roll AMI ami-0f9e8d7c6b5a4f3e2 to staging only; prod must not change.",
      done: "Staging runs the new AMI; prod untouched.",
      files: {
        "versions.tf": versions(),
        "variables.tf": hcl(`
          variable "ami" {
            type    = string
            default = "${AMI}"
          }
        `),
        "main.tf": hcl(`
          locals {
            replicas = {
              staging = 1
              prod    = 3
            }
          }

          resource "aws_instance" "app" {
            count         = local.replicas[terraform.workspace]
            ami           = var.ami
            instance_type = "t3.small"

            tags = {
              Name = "app-\${terraform.workspace}-\${count.index}"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        quietly(w, "terraform init", "terraform workspace new staging", "terraform apply -auto-approve", "terraform workspace new prod", "terraform apply -auto-approve");
        w.memo.prod = Object.values(w.state.resources).map((r) => r.id).sort();
        w.lastPlan = null;
      },
      won: (w) => { const st = w.states().staging; const prod = Object.values(w.states().prod.resources).map((r) => r.id).sort(); return JSON.stringify(prod) === JSON.stringify(w.memo.prod) && w.memo.prod.every((id) => live(w, "aws_instance", id)) && Object.values(st.resources).length === 1 && Object.values(st.resources).every((r) => (w.cloudGet(r.type, r.id) || { attrs: {} }).attrs.ami === "ami-0f9e8d7c6b5a4f3e2"); },
      check: (w) => { const ok = w.memo.prod.every((id) => live(w, "aws_instance", id)); return { label: `Workspace ${w.ws}`, ok, text: ok ? "prod untouched" : "prod servers replaced" }; },
      hints: [
        "terraform workspace show. Which environment is this plan for?",
        "Each workspace has its own state; the code is shared. The plan replaces three servers because it is prod's state, and changing the AMI default would hit prod on its next apply too.",
        "terraform workspace select staging, then terraform apply -var ami=ami-0f9e8d7c6b5a4f3e2."
      ],
      lesson: "Check the workspace (terraform workspace show, or the prompt in your shell) before every apply; Terraform names it in the approval question. Many teams use separate directories or accounts per environment instead.",
      tries: ["terraform workspace show", "terraform plan -var ami=ami-0f9e8d7c6b5a4f3e2"]
    },
    {
      id: "backendmigrate",
      title: "Move state to an S3 backend",
      level: "13",
      story: "State has lived in a terraform.tfstate on your laptop. You added an S3 backend block so CI and the team can share it.",
      goal: "Move the existing state into S3 without recreating anything.",
      done: "State lives in S3; plan is clean.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "site" {
            bucket = "quest-site-2026"
          }

          resource "aws_instance" "web" {
            ami           = "${AMI}"
            instance_type = "t3.small"
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: STATE_BUCKET,
      setup: (w) => { quietly(w, "terraform init", "terraform apply -auto-approve"); w.memo.ids = Object.values(w.state.resources).map((r) => r.id).sort(); w.fs["versions.tf"] = versions("~> 5.0", S3_BACKEND()); w.lastPlan = null; },
      won: (w) => { const st = (w.stores["s3://quest-tfstate/shop/terraform.tfstate"] || {}).default; return Boolean(st) && JSON.stringify(Object.values(st.resources).map((r) => r.id).sort()) === JSON.stringify(w.memo.ids) && w.storeKey().startsWith("s3://") && cleanPlan(w); },
      check: (w) => { const st = (w.stores["s3://quest-tfstate/shop/terraform.tfstate"] || {}).default; const n = st ? Object.keys(st.resources).length : 0; return { label: "State in S3", ok: n === 2, text: `${n} of 2 resources` }; },
      hints: [
        "terraform plan asks for init. What does terraform init offer to do with the existing state?",
        "-reconfigure switches to the new backend without copying anything: the empty S3 state would make Terraform plan to create everything again.",
        "terraform init -migrate-state and answer yes to copy the state, then terraform plan."
      ],
      lesson: "Changing backends is a state migration. terraform init -migrate-state copies it; check with terraform state list and a clean plan, and lock the old file away.",
      tries: ["terraform plan", "terraform init"]
    },
    {
      id: "staleplan",
      title: "Saved plan is stale",
      level: "14",
      story: "This morning you saved a plan to tfplan for review. Since then a teammate's pipeline ran against the same state. Now terraform apply tfplan fails.",
      goal: "Apply your tag change with a plan that matches the current state.",
      done: "Your change is applied.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "site" {
            bucket = "quest-site-2026"

            tags = {
              CostCenter = "1042"
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => {
        const want = w.fs["main.tf"];
        w.fs["main.tf"] = want.replace('"1042"', '"0001"');
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["main.tf"] = want;
        quietly(w, "terraform plan -out=tfplan", "terraform apply -refresh-only -auto-approve");
        w.lastPlan = null;
      },
      won: (w) => (attrOf(w, "aws_s3_bucket.site", "tags") || {}).CostCenter === "1042",
      check: (w) => { const t = (attrOf(w, "aws_s3_bucket.site", "tags") || {}).CostCenter; return { label: "CostCenter tag", ok: t === "1042", text: t }; },
      hints: [
        "terraform apply tfplan. A saved plan records the exact state it was made from.",
        "Someone changed the state after you planned, so Terraform refuses to apply a plan that might no longer be true. Re-running the same file gives the same answer.",
        "terraform plan -out=tfplan, review it, then terraform apply tfplan."
      ],
      lesson: "Saved plans make review safe: what you approve is what runs, and a plan made on older state is rejected. In CI, plan and apply in the same pipeline run, with the lock held in between.",
      tries: ["terraform apply tfplan", "terraform show tfplan"]
    },
    {
      id: "nolock",
      title: "Backend without locking",
      level: "13",
      story: "Two pipelines applied at the same moment yesterday and one overwrote the other's state. The S3 backend has no lock configured.",
      goal: "Turn on state locking for this backend.",
      done: "The backend locks the state.",
      files: {
        "versions.tf": versions("~> 5.0", S3_BACKEND().replace('\n        dynamodb_table = "tf-locks"', "").replace("region         =", "region =").replace("bucket         =", "bucket =").replace("key            =", "key    =")),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".gitignore": GITIGNORE
      },
      cloud: STATE_BUCKET,
      setup: (w) => { quietly(w, "terraform init", "terraform apply -auto-approve"); w.lastPlan = null; },
      won: (w) => holdsLock(w) && Boolean(w.lastPlan && w.lastPlan.locked) && w.storeKey() === "s3://quest-tfstate/shop/terraform.tfstate",
      check: (w) => ({ label: "State locking", ok: holdsLock(w), text: holdsLock(w) ? (w.dot.backend.cfg.use_lockfile ? "S3 lock file" : "DynamoDB table") : "off" }),
      hints: [
        "cat versions.tf: what does the s3 backend use to lock? aws dynamodb scan --table-name tf-locks shows a lock table exists.",
        "Locking is part of the backend configuration; -lock=true cannot lock when the backend has nowhere to put the lock. After changing the block, init must take it in, and the state does not move.",
        "Add dynamodb_table = \"tf-locks\" (or use_lockfile = true on 1.10+) to the backend block, run terraform init -reconfigure, then terraform plan."
      ],
      lesson: "Remote state needs a lock: use_lockfile = true (S3 native, Terraform 1.10+) or a DynamoDB table. Without one, concurrent applies silently overwrite each other.",
      tries: ["cat versions.tf", "terraform plan"]
    },
    {
      id: "backendbucket",
      title: "Backend bucket does not exist",
      level: "13",
      story: "A fresh clone of the infra repository. terraform init stops at the backend.",
      goal: "Initialise against the team's real state bucket and plan.",
      done: "Initialised; shared state found.",
      files: {
        "versions.tf": versions("~> 5.0", S3_BACKEND().replace('"quest-tfstate"', '"quest-tf-state"')),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".gitignore": GITIGNORE
      },
      cloud: STATE_BUCKET,
      setup: (w) => {
        const want = w.fs["versions.tf"];
        w.fs["versions.tf"] = want.replace('"quest-tf-state"', '"quest-tfstate"');
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["versions.tf"] = want;
        w.dot = null;
        delete w.fs[".terraform.lock.hcl"];
        for (const f of Object.keys(w.fs)) if (f.startsWith(".terraform/")) delete w.fs[f];
        w.lastPlan = null;
      },
      won: (w) => w.storeKey() === "s3://quest-tfstate/shop/terraform.tfstate" && cleanPlan(w),
      check: (w) => ({ label: "Backend", ok: w.storeKey() === "s3://quest-tfstate/shop/terraform.tfstate", text: w.dot && w.dot.backend ? w.dot.backend.cfg.bucket : "not initialised" }),
      hints: [
        "terraform init names the bucket. aws s3 ls lists the buckets that exist.",
        "The backend block has a typo. Creating a new bucket with that name would give you an empty state, and the next apply would try to recreate everything.",
        "Fix bucket = \"quest-tfstate\" in versions.tf, then terraform init and terraform plan."
      ],
      lesson: "The backend block points at shared state; a wrong bucket or key means an empty state, not an error later. A clean plan after init proves you found the right one.",
      tries: ["terraform init", "aws s3 ls"]
    },
    {
      id: "sensitiveout",
      title: "Output refers to sensitive values",
      level: "15",
      story: "The app team needs the database connection string. You added an output, and the plan refuses it.",
      goal: "Provide the connection string output without printing the password in plan and apply logs.",
      done: "Output stored, marked sensitive.",
      files: {
        "versions.tf": versions(),
        "variables.tf": 'variable "db_password" {\n  type      = string\n  sensitive = true\n}\n',
        "main.tf": hcl(`
          resource "aws_db_instance" "app" {
            identifier          = "app-db"
            engine              = "postgres"
            instance_class      = "db.t4g.small"
            username            = "app"
            password            = var.db_password
            skip_final_snapshot = true
          }
        `),
        ".gitignore": GITIGNORE
      },
      env: { TF_VAR_db_password: "changeme-changeme" },
      setup: (w) => {
        quietly(w, "terraform init", "terraform apply -auto-approve");
        w.fs["outputs.tf"] = hcl(`
          output "database_url" {
            value = format("postgres://%s:%s@%s/app", "app", var.db_password, aws_db_instance.app.address)
          }
        `);
      },
      won: (w) => Boolean(w.state.outputs.database_url && w.state.outputs.database_url.sensitive) && /sensitive\s*=\s*true/.test(w.fs["variables.tf"] || ""),
      check: (w) => { const o = w.state.outputs.database_url; return { label: "database_url", ok: Boolean(o && o.sensitive), text: !o ? "not in state" : o.sensitive ? "sensitive" : "printed in logs" }; },
      hints: [
        "terraform plan. Which value makes the output sensitive?",
        "Removing sensitive from the variable, or wrapping it in nonsensitive(), silences the error by printing the password everywhere.",
        "Add sensitive = true to the output block, then terraform apply. terraform output -raw database_url reads it when needed."
      ],
      lesson: "Sensitivity follows values through expressions; an output that contains one must say sensitive = true. It hides values in the CLI, not in the state, so protect the state too.",
      tries: ["terraform plan", "cat outputs.tf"]
    },
    {
      id: "dbpassword",
      title: "Database password in Git and state",
      level: "15",
      story: "A security review found the reports database password written in main.tf, and anyone who can read the state can read it too.",
      goal: "Get the password out of the code and out of the state, without replacing the database.",
      done: "AWS manages the password; code and state are clean.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_db_instance" "reports" {
            identifier          = "reports-db"
            engine              = "postgres"
            instance_class      = "db.t4g.small"
            username            = "reports"
            password            = "changeme-changeme"
            skip_final_snapshot = true
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => { quietly(w, "terraform init", "terraform apply -auto-approve"); w.memo.id = w.state.resources["aws_db_instance.reports"].id; },
      won: (w) => { const r = w.state.resources["aws_db_instance.reports"]; return Boolean(r) && r.id === w.memo.id && !r.attrs.password && r.attrs.manage_master_user_password === true && !/password\s*=\s*"/.test(filesText(w)); },
      check: (w) => { const r = w.state.resources["aws_db_instance.reports"]; return { label: "Password in state", ok: Boolean(r) && !r.attrs.password, text: !r ? "no database" : r.attrs.password ? "yes" : "no" }; },
      hints: [
        "terraform state pull | grep password. sensitive = true would hide it on screen, not in the state.",
        "RDS can create and rotate the master password in Secrets Manager itself, so Terraform never sees it.",
        "Replace password = ... with manage_master_user_password = true, then terraform apply. Rotate the old password: it was in Git history."
      ],
      lesson: "Anything Terraform passes to a provider lands in state. Let the service own secrets (manage_master_user_password, Secrets Manager, IAM auth), keep state encrypted and access-controlled, and treat a committed secret as leaked.",
      tries: ["terraform state pull | grep password", "grep -rn password ."]
    },
    {
      id: "openssh",
      title: "SSH open to the internet",
      level: "15",
      story: "The bastion security group, copied from an old example, allows SSH from 0.0.0.0/0. The security scan flags it as critical.",
      goal: "Allow SSH only from the office VPN range 10.20.0.0/16 (or remove it), keeping HTTPS.",
      done: "SSH is no longer open to the internet.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_security_group" "bastion" {
            name        = "bastion"
            description = "HTTPS and SSH"
            vpc_id      = "${VPC.id}"

            ingress {
              from_port   = 22
              to_port     = 22
              protocol    = "tcp"
              cidr_blocks = ["0.0.0.0/0"]
            }

            ingress {
              from_port   = 443
              to_port     = 443
              protocol    = "tcp"
              cidr_blocks = ["0.0.0.0/0"]
            }
          }
        `),
        ".gitignore": GITIGNORE
      },
      cloud: [VPC],
      setup: (w) => quietly(w, "terraform init", "terraform apply -auto-approve"),
      won: (w) => {
        const r = w.state.resources["aws_security_group.bastion"];
        const o = r && w.cloudGet(r.type, r.id);
        if (!o) return false;
        const wide = (c) => Number(String(c).split("/")[1]) < 8;
        return o.attrs.ingress.some((x) => x.from_port === 443) && !o.attrs.ingress.some((x) => x.from_port !== 443 && (x.cidr_blocks || []).some(wide));
      },
      check: (w) => { const r = w.state.resources["aws_security_group.bastion"]; const o = r && w.cloudGet(r.type, r.id); const bad = o && o.attrs.ingress.filter((x) => x.from_port !== 443 && (x.cidr_blocks || []).some((c) => Number(c.split("/")[1]) < 8)); return { label: "Open to the internet", ok: Boolean(o) && !bad.length, text: !o ? "no group" : bad.length ? `port ${bad.map((x) => x.from_port).join(", ")}` : "HTTPS only" }; },
      hints: [
        "aws ec2 describe-security-groups. Which rules accept 0.0.0.0/0?",
        "Moving SSH to another port or narrowing to 0.0.0.0/1 still leaves it on the internet. Limit the source, or drop SSH for Session Manager.",
        "In the port 22 block set cidr_blocks = [\"10.20.0.0/16\"] (or delete the block), then terraform apply."
      ],
      lesson: "0.0.0.0/0 on admin ports is the most common finding in Terraform scans. Review security groups in plans, run a scanner (trivy config, checkov) in CI, and prefer SSM over SSH.",
      tries: ["aws ec2 describe-security-groups", "cat main.tf"]
    },
    {
      id: "publicbucket",
      title: "Public bucket ACL rejected",
      level: "15",
      story: "A tutorial said to add acl = \"public-read\" so a partner can read the reports. Apply creates the bucket, then fails on the ACL.",
      goal: "Create the reports bucket private, with all public access blocked.",
      done: "The bucket is private and blocks public access.",
      files: {
        "versions.tf": versions(),
        "main.tf": hcl(`
          resource "aws_s3_bucket" "reports" {
            bucket = "quest-partner-reports"
          }

          resource "aws_s3_bucket_acl" "reports" {
            bucket = aws_s3_bucket.reports.id
            acl    = "public-read"
          }
        `),
        ".gitignore": GITIGNORE
      },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => {
        const pab = w.cloudAll("aws_s3_bucket_public_access_block").find((o) => o.attrs.bucket === "quest-partner-reports");
        const acl = w.cloudAll("aws_s3_bucket_acl").find((o) => o.attrs.bucket === "quest-partner-reports");
        return live(w, "aws_s3_bucket", "quest-partner-reports") && Boolean(pab) && ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"].every((k) => pab.attrs[k] === true) && (!acl || acl.attrs.acl === "private");
      },
      check: (w) => { const acl = w.cloudAll("aws_s3_bucket_acl").find((o) => o.attrs.bucket === "quest-partner-reports"); const pab = w.cloudAll("aws_s3_bucket_public_access_block").length; return { label: "quest-partner-reports", ok: !(acl && acl.attrs.acl !== "private") && pab > 0, text: acl && acl.attrs.acl !== "private" ? "public" : pab ? "private, blocked" : live(w, "aws_s3_bucket", "quest-partner-reports") ? "private, not blocked" : "not created" }; },
      hints: [
        "terraform apply. New buckets have Object Ownership set to BucketOwnerEnforced, which turns ACLs off.",
        "Switching ownership to ObjectWriter would let the public ACL through: exactly what the default protects you from. Share with the partner through a bucket policy for their account, or presigned URLs.",
        "Delete the aws_s3_bucket_acl block, add aws_s3_bucket_public_access_block for the bucket with all four block/ignore/restrict settings true, then terraform apply."
      ],
      lesson: "Modern S3 disables ACLs by default. Keep it that way, add a public access block to every bucket, and grant access with IAM or bucket policies naming who, not with public-read.",
      tries: ["terraform apply", "aws s3 ls"]
    },
    {
      id: "credentials",
      title: "No valid credential sources found",
      level: "15",
      story: "Day one on a new laptop. The AWS CLI profile is set up, but terraform plan cannot find any credentials.",
      goal: "Run a plan with your AWS profile, without putting keys in the code.",
      done: "Planned with your profile.",
      noCredentials: true,
      files: {
        "versions.tf": versions(),
        "main.tf": 'resource "aws_s3_bucket" "site" {\n  bucket = "quest-site-2026"\n}\n',
        ".gitignore": GITIGNORE
      },
      setup: (w) => quietly(w, "terraform init"),
      won: (w) => Boolean(w.lastPlan) && Boolean(w.env.AWS_PROFILE) && !/access_key|secret_key/.test(filesText(w)),
      check: (w) => ({ label: "Credentials", ok: Boolean(w.env.AWS_PROFILE), text: w.env.AWS_PROFILE ? `profile ${w.env.AWS_PROFILE}` : /access_key/.test(filesText(w)) ? "keys in code" : "none" }),
      hints: [
        "terraform plan, then env | grep AWS. Where does the provider look for credentials?",
        "The provider reads the same chain as the AWS CLI: environment variables, AWS_PROFILE, SSO, instance roles. Keys in a provider block end up in Git.",
        "export AWS_PROFILE=quest (check with aws sts get-caller-identity), then terraform plan."
      ],
      lesson: "Never put access keys in Terraform. Use profiles or SSO locally and OIDC roles in CI; the provider finds them without any code.",
      tries: ["terraform plan", "aws sts get-caller-identity"]
    }
  ];

  // Easiest first, then the order an engineer meets them.
  const GROUPS = [
    ["Basics", ["noinit", "fmtcheck", "unsupported", "invalidref", "outputmissing"]],
    ["State", ["drift", "import", "moved", "removed", "taint"]],
    ["Plans and changes", ["dbreplace", "cbd", "countshift", "ignorechanges", "target", "cycle", "teardown"]],
    ["Modules and variables", ["tfvarsprec", "varci", "validation", "instancekey", "foreachunknown", "modoutput", "datanotfound", "modpin", "dependson"]],
    ["Providers and versions", ["lockedversion", "provconflict", "requiredversion", "newerstate", "platformlock", "provalias"]],
    ["Collaboration and CI", ["lockstuck", "backendbucket", "backendmigrate", "nolock", "workspace", "staleplan"]],
    ["Security", ["credentials", "sensitiveout", "dbpassword", "openssh", "publicbucket"]]
  ];
  const ORDER = GROUPS.flatMap(([, ids]) => ids);
  SCENARIOS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  for (const [group, ids] of GROUPS) for (const id of ids) SCENARIOS.find((x) => x.id === id).group = group;

  // Cheat-sheet placeholders, filled from the open scenario.
  function fillBlanks(w, cmd) {
    const res = Object.values(w.state.resources).find((r) => r.mode === "managed");
    const lock = w.locks[w.storeKey()];
    const v = {
      addr: res && res.addr, id: res && res.id, "lock-id": lock && lock.id, ws: w.ws === "default" ? "staging" : w.ws, file: "main.tf",
      platform: RUNNER, version: CLI, name: Object.keys(w.state.outputs)[0], expr: "var.environment", plan: "tfplan"
    };
    return cmd.replace(/<([a-z-]+)>/g, (m, k) => (v[k] == null ? m : String(v[k])));
  }

  root.TQSim = { SCENARIOS, GROUPS, World, shell, tokenize, satisfies, fillBlanks, readLock, quietly };

  // --- UI ------------------------------------------------------------------------

  if (typeof document === "undefined") return;
  const term = document.getElementById("pg-term");
  if (!term) return;
  const $ = (id) => document.getElementById(id);
  const out = $("pg-out");
  const form = $("pg-form");
  const input = $("pg-input");
  const map = $("pg-map");
  const goal = $("pg-goal");
  const picker = $("pg-scenarios");
  const tries = $("pg-try");
  const editor = $("pg-editor");
  const story = $("pg-story");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const KEY = "dq-terraform:pg-solved";
  const saved = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } },
    add(id) { try { localStorage.setItem(KEY, JSON.stringify([...new Set([...saved.get(), id])])); } catch { /* private mode */ } }
  };

  let scenario = SCENARIOS[0];
  let world;
  let solved;
  let hintLevel;
  let editing = null;
  const typed = [];
  let typedPos = 0;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function print(text, cls) {
    out.append(el("div", "pg-line" + (cls ? " " + cls : ""), text));
    out.scrollTop = out.scrollHeight;
  }

  function renderPicker() {
    const done = new Set(saved.get());
    picker.replaceChildren(...GROUPS.map(([group, ids]) => {
      const row = el("div", "pg-group");
      const n = ids.filter((id) => done.has(id)).length;
      const name = el("span", "pg-group-name", group);
      name.append(el("span", "pg-group-count" + (n === ids.length ? " done" : ""), `${n}/${ids.length}`));
      const items = el("div", "pg-group-items");
      for (const id of ids) {
        const s = SCENARIOS.find((x) => x.id === id);
        const b = el("button", "pg-scn");
        b.type = "button";
        b.setAttribute("aria-pressed", String(s === scenario));
        if (done.has(id)) b.append(el("span", "pg-scn-done", "✓"));
        b.append(document.createTextNode(s.title));
        b.title = done.has(id) ? `${s.title} (solved)` : s.title;
        b.addEventListener("click", () => { load(id); linkTo(id); });
        items.append(b);
      }
      row.append(name, items);
      return row;
    }));
  }

  // State beside reality: each resource, whether the cloud still matches it,
  // and what the last plan wanted to do to it.
  let seen = new Map();
  function renderMap() {
    const w = world;
    const be = w.dot && w.dot.backend;
    const lock = w.locks[w.storeKey()];
    const head = el("div", "pg-meta");
    const chip = (label, value, bad) => { const c = el("span", "pg-meta-item" + (bad ? " bad" : "")); c.append(el("span", "muted", label + " "), el("strong", null, value)); return c; };
    head.append(chip("Terraform", w.cli), chip("Workspace", w.ws, w.ws === "prod"), chip("Backend", be ? `s3 · ${be.cfg.bucket}` : w.dot ? "local" : "not initialised", !w.dot));
    if (be) head.append(chip("Lock", lock ? "held" : holdsLock(w) ? "free" : "none configured", Boolean(lock) || !holdsLock(w)));
    const planned = new Map(((w.lastPlan && w.lastPlan.ws === w.ws && !w.lastPlan.applied && w.lastPlan.changes) || []).map((c) => [c.addr, c.action]));
    const list = el("div", "pg-res");
    const rows = Object.values(w.state.resources).filter((r) => r.mode === "managed");
    for (const addr of planned.keys()) if (!w.state.resources[addr]) rows.push({ addr, planned: true });
    if (!rows.length) list.append(el("p", "muted small", "State is empty: Terraform manages nothing here yet."));
    rows.forEach((r, i) => {
      const o = r.planned ? null : w.cloudGet(r.type, r.id);
      const st = r.planned ? "plan" : !o ? "gone" : same(o.attrs, r.attrs) ? "ok" : "drift";
      const act = planned.get(r.addr);
      const row = el("button", `pg-r ${st}`);
      row.type = "button";
      const was = seen.get(r.addr);
      if (was === undefined) { row.classList.add("is-new"); row.style.animationDelay = `${Math.min(i, 10) * 30}ms`; } else if (was !== "ok" && st === "ok") row.classList.add("is-healed");
      const sym = { create: "+", update: "~", replace: "-/+", delete: "-", import: "←", forget: "." }[act];
      row.append(el("span", "pg-dot", st === "ok" ? "✓" : st === "plan" ? "+" : "!"), el("span", "pg-r-addr", r.addr), el("span", "pg-r-note", sym ? `plan ${sym}` : st === "drift" ? "drifted" : st === "gone" ? "deleted outside" : st === "plan" ? "" : r.tainted ? "tainted" : ""));
      row.title = `${r.addr}: ${st === "ok" ? "matches the real object" : st === "drift" ? "the real object changed outside Terraform" : st === "gone" ? "the real object no longer exists" : "only in the last plan"}. Click to use the address.`;
      row.querySelector(".pg-dot").setAttribute("aria-hidden", "true");
      row.addEventListener("click", () => { const v = input.value; input.value = (v && !v.endsWith(" ") ? v + " " : v) + r.addr; input.focus(); });
      list.append(row);
    });
    seen = new Map(rows.map((r) => [r.addr, r.planned ? "plan" : w.cloudGet(r.type, r.id) && same(w.cloudGet(r.type, r.id).attrs, r.attrs) ? "ok" : "bad"]));
    const r = scenario.check(w);
    const check = el("div", "pg-check " + (r.ok ? "ok" : "bad"));
    check.append(el("span", "pg-check-label", r.label), el("span", "pg-check-text", r.text));
    map.replaceChildren(head, list, check);
  }

  function editable() {
    return Object.keys(world.fs).filter((f) => !f.startsWith(".terraform/") && world.fs[f] !== "(binary plan file)").sort((a, b) => (a.startsWith(".") - b.startsWith(".")) || (a.includes("/") - b.includes("/")) || a.localeCompare(b));
  }
  function renderEditor() {
    const list = editable();
    if (world.editing && list.includes(world.editing)) { editing = world.editing; world.editing = null; }
    if (!editing || !list.includes(editing)) editing = list.find((f) => f === "main.tf") || list[0];
    const tabs = el("div", "seg pg-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "File");
    for (const f of list) {
      const b = el("button", null, f);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(f === editing));
      b.addEventListener("click", () => { editing = f; renderEditor(); });
      tabs.append(b);
    }
    const area = el("textarea", "pg-edit");
    area.spellcheck = false;
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("aria-label", `Edit ${editing}`);
    area.rows = Math.min(18, Math.max(8, (world.fs[editing] || "").split("\n").length + 1));
    area.value = world.fs[editing] || "";
    area.addEventListener("input", () => { world.fs[editing] = area.value; });
    area.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const at = area.selectionStart;
      area.setRangeText("  ", at, area.selectionEnd, "end");
      world.fs[editing] = area.value;
    });
    editor.replaceChildren(el("div", "pg-panel-name", "Files in ~/infra"), tabs, area,
      el("p", "note", "Saved as you type, like an editor with autosave. Run terraform fmt to tidy, then plan."));
  }

  function renderTries() {
    tries.replaceChildren(el("span", "muted small", "Try"), ...[...scenario.tries, "hint", "reset"].map((cmd) => {
      const b = el("button", "chip", cmd);
      b.type = "button";
      b.addEventListener("click", () => { run(cmd); input.focus(); });
      return b;
    }));
  }

  function setPrompt() {
    form.querySelector("span").textContent = world.console ? ">" : world.pending ? "?" : "$";
    input.placeholder = world.console ? "var.environment   (exit to leave)" : world.pending ? "yes" : "terraform plan";
  }

  // Deep links: the address bar always names the open scenario.
  function linkTo(id) { if (!location.hash || location.hash === "#path" || location.hash.startsWith("#play/")) window.history.replaceState(null, "", "#play/" + id); }

  function load(id) {
    scenario = SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
    world = new World(scenario);
    seen = new Map();
    solved = false;
    hintLevel = 0;
    editing = null;
    out.replaceChildren();
    story.replaceChildren(el("strong", null, scenario.title + ". "), document.createTextNode(scenario.story));
    print("dev@laptop ~/infra. Find out why with terraform, fix the files in the editor, and check the result.", "dim");
    print("Type 'help' for commands, 'hint' if stuck. Nothing here touches a real cloud.", "dim");
    print("");
    goal.textContent = "Goal: " + scenario.goal;
    goal.className = "pg-goal";
    renderPicker();
    renderTries();
    renderMap();
    renderEditor();
    setPrompt();
    const current = picker.querySelector('[aria-pressed="true"]');
    if (current && picker.scrollWidth > picker.clientWidth) picker.scrollLeft = current.offsetLeft - 48;
  }

  function check() {
    if (solved || !scenario.won(world)) return;
    solved = true;
    saved.add(scenario.id);
    renderPicker();
    const b = picker.querySelector('.pg-scn[aria-pressed="true"]');
    if (b) { b.classList.add("just-solved"); b.closest(".pg-group").querySelector(".pg-group-count").classList.add("bump"); }
    goal.textContent = "Fixed. " + scenario.done;
    goal.className = "pg-goal done";
    print("");
    print("✓ Fixed. " + scenario.lesson, "ok");
    const lv = (window.QUEST && window.QUEST.levels || []).find((l) => l.id === scenario.level);
    if (lv) print(`  Read more in Level ${lv.id} · ${lv.title}.`, "dim");
    const next = SCENARIOS.find((s) => !saved.get().includes(s.id));
    print(next ? `  Next scenario: ${next.title}. Pick it above, or type 'next'.` : "  You solved every scenario.", "dim");
  }

  function run(raw) {
    const line = raw.replace(/\s+$/, "");
    const prompt = form.querySelector("span").textContent;
    print(`${prompt} ${line}`, "cmd");
    const cmd = line.trim();
    if (!world.pending && !world.console) {
      if (cmd === "clear") { out.replaceChildren(); return; }
      if (cmd === "reset") { load(scenario.id); return; }
      if (cmd === "next") { const n = SCENARIOS.find((s) => !saved.get().includes(s.id) && s !== scenario) || SCENARIOS[(SCENARIOS.indexOf(scenario) + 1) % SCENARIOS.length]; load(n.id); linkTo(n.id); return; }
      if (cmd === "hint") { print(scenario.hints[Math.min(hintLevel++, scenario.hints.length - 1)], "dim"); return; }
    }
    let result;
    try { result = shell(world, line); } catch {
      result = [["(the playground could not run that command; check its quoting, or type 'help')", "warn"]];
    }
    for (const [text, cls] of result) print(text, cls);
    renderMap();
    if (document.activeElement && !document.activeElement.classList.contains("pg-edit")) renderEditor();
    setPrompt();
    check();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value;
    if (value.trim()) { typed.push(value); typedPos = typed.length; }
    input.value = "";
    run(value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && typedPos > 0) { typedPos--; input.value = typed[typedPos]; e.preventDefault(); }
    if (e.key === "ArrowDown") { typedPos = Math.min(typed.length, typedPos + 1); input.value = typed[typedPos] || ""; e.preventDefault(); }
    if (e.key === "Tab" && input.value.trim()) {
      e.preventDefault();
      const v = input.value;
      const start = v.lastIndexOf(" ") + 1;
      const stem = v.slice(start);
      const words = [...Object.keys(world.state.resources), ...editable(), "init", "validate", "plan", "apply", "destroy", "state", "list", "show", "import", "output", "workspace", "select", "force-unlock", "providers", "lock", "-auto-approve", "-target=", "-replace=", "-refresh-only", "-migrate-state", "-reconfigure", "-upgrade", "terraform"];
      const hits = [...new Set(words)].filter((x) => x.startsWith(stem) && x !== stem);
      if (hits.length === 1) input.value = v.slice(0, start) + hits[0] + (hits[0].endsWith("=") ? "" : " ");
      else if (hits.length > 1) print(hits.join("   "), "dim");
    }
  });
  out.addEventListener("click", () => { if (!window.getSelection().toString()) input.focus(); });

  const reveal = () => { term.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" }); input.focus({ preventScroll: true }); };
  window.TQPlayground = {
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, group: s.group, level: s.level, story: s.story })),
    load: (id, quiet) => { load(id); if (!quiet) reveal(); },
    current: () => scenario.id,
    // From the cheat sheet: open the scenario a command needs, fill its blanks
    // from that scenario and run it; what cannot be filled is left to edit.
    prefill: (cmd, where) => {
      if (where && where !== "any" && where !== scenario.id) { load(where); linkTo(where); }
      reveal();
      const full = fillBlanks(world, cmd);
      if (/<[^>]+>/.test(full)) input.value = full;
      else run(full);
    }
  };
  load(SCENARIOS[0].id);
})(typeof window !== "undefined" ? window : globalThis);
