// Throws thousands of random and malformed commands and .tf edits at the
// simulator. Any exception fails the run; every result must be printable lines.
// Run with: node tests/fuzz_playground.js [rounds]
"use strict";
const path = require("path");
const assert = require("assert");

require(path.resolve(__dirname, "../site/hcl.js"));
require(path.resolve(__dirname, "../site/playground.js"));
const { SCENARIOS, World, shell } = globalThis.TQSim;

let seed = Number(process.env.FUZZ_SEED) || 20261030;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = (list) => list[rand(list.length)];

const WORDS = ["terraform", "init", "plan", "apply", "destroy", "validate", "fmt", "state", "list", "show", "mv", "rm", "pull", "push", "import", "output", "workspace",
  "new", "select", "delete", "force-unlock", "taint", "untaint", "providers", "lock", "console", "graph", "refresh", "version", "-auto-approve", "-upgrade", "-reconfigure",
  "-migrate-state", "-backend=false", "-refresh-only", "-destroy", "-target=aws_instance.app", "-replace=aws_instance.api", "-var", "environment=prod", "-var=x", "-var-file=x.tfvars",
  "-out=tfplan", "tfplan", "-lock=false", "-input=false", "-json", "-raw", "-check", "-diff", "-recursive", "-platform=linux_amd64", "-force", "-or-create", "staging", "prod",
  "aws_s3_bucket.site", "aws_instance.web", "aws_instance.runner[0]", 'aws_instance.runner["bob"]', "module.vpc", "module.network.aws_vpc.this", "nimbus-assets-2026", "yes", "no",
  "ls", "-a", "cat", "-n", "main.tf", "versions.tf", "variables.tf", ".terraform.lock.hcl", "edit", "sed", "-i", "s/a/b/", "s/(/x/", "echo", ">>", ">", "rm", "-rf", ".terraform",
  "export", "TF_VAR_environment=staging", "unset", "AWS_PROFILE", "env", "grep", "-rn", "password", "|", "&&", ";", "||", "head", "tail", "wc", "-l", "tfenv", "use", "install",
  "1.10.5", "1.9.8", "aws", "sts", "get-caller-identity", "s3", "ec2", "describe-instances", "dynamodb", "scan", "--table-name", "tf-locks", "ci", "run", "tofu", "'", "\"", "$", "${x}", "\\", "--", "-"];
const LINES = ['resource "aws_s3_bucket" "x" {', "}", "{", 'bucket = "b"', "count = 2", "for_each = toset([\"a\"])", "for_each = [1, 2]", "x = var.nope", "y = local.z", "z = aws_nope.n.id",
  'tags = { Name = "${each.key}" }', "lifecycle {", "prevent_destroy = true", "create_before_destroy = true", "ignore_changes = [tags]", 'moved {', 'from = aws_instance.web', 'to = aws_instance.app',
  'removed {', 'import {', 'id = "nimbus-assets-2026"', 'variable "v" {', "default = 1", 'output "o" {', "value = var.v", "sensitive = true", 'module "m" {', 'source = "./nope"',
  'data "aws_vpc" "v" {', 'provider = aws.x', "depends_on = [aws_s3_bucket.x]", "a = [", "b = (1 +", '"unterminated', "<<EOT", "EOT", "c = 1 ? 2 : 3", "d = [for x in [1] : x]",
  "e = cidrsubnet(\"10.0.0.0/16\", 40, 1)", "f = file(\"nope\")", "g = jsondecode(\"{\")", "# comment", "/* open comment", ""];

const rounds = Number(process.argv[2]) || 3000;
let n = 0;
for (let i = 0; i < rounds; i++) {
  const s = SCENARIOS[i % SCENARIOS.length];
  const w = new World(s);
  for (let j = 0; j < 5; j++) {
    let line;
    if (rand(5) === 0) {
      const f = pick(["main.tf", "extra.tf", "terraform.tfvars", "versions.tf"]);
      w.fs[f] = Array.from({ length: 1 + rand(10) }, () => pick(LINES)).join(pick(["\n", "\r\n"]));
      line = pick(["terraform plan", "terraform validate", "terraform fmt", "terraform apply -auto-approve", "terraform init", "terraform console", "ci run"]);
    } else if (rand(4) === 0) line = String.fromCharCode(...Array.from({ length: rand(40) }, () => 32 + rand(95)));
    else line = Array.from({ length: 1 + rand(8) }, () => pick(WORDS)).join(" ");
    if (rand(3) === 0) line = "terraform " + line;
    try {
      const out = shell(w, line);
      assert.ok(Array.isArray(out));
      for (const l of out) assert.ok(Array.isArray(l) && typeof l[0] === "string", "each line is [text, class]");
      s.won(w);
      const c = s.check(w);
      assert.ok(c && typeof c.label === "string");
    } catch (err) {
      console.error(`scenario ${s.id}, command: ${JSON.stringify(line)}`);
      throw err;
    }
    n++;
  }
}
console.log(`fuzz ok: ${n} commands across ${SCENARIOS.length} scenarios, 0 exceptions`);
