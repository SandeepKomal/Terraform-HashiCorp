// Drives the playground simulator without a browser: every scenario starts
// broken, the tempting wrong moves leave it broken, and the intended fix solves it.
// Run with: node tests/check_playground.js
"use strict";
const path = require("path");
const assert = require("assert");

require(path.resolve(__dirname, "../site/hcl.js"));
require(path.resolve(__dirname, "../site/playground.js"));
const { SCENARIOS, World, shell, tokenize, satisfies, fillBlanks } = globalThis.TQSim;
const H = globalThis.TQHCL;

const fresh = (id) => new World(SCENARIOS.find((s) => s.id === id));
const run = (w, cmd) => shell(w, cmd).map(([t]) => t).join("\n");
const won = (w) => w.scenario.won(w);
const quiet = () => {};
const last = (o, n = 8) => o.split("\n").slice(-n).join("\n");
// Replace text in a file, failing loudly if the text is not there.
function sub(w, file, from, to) {
  assert.ok(w.fs[file].includes(from), `${file} should contain ${JSON.stringify(from)}`);
  w.fs[file] = w.fs[file].replace(from, to);
}

assert.deepStrictEqual(tokenize(`sed -i 's/a b/c/' main.tf`), ["sed", "-i", "s/a b/c/", "main.tf"]);
assert.ok(satisfies("5.80.0", "~> 5.0") && !satisfies("6.2.0", "~> 5.0") && satisfies("1.10.5", ">= 1.10, < 2.0") && !satisfies("5.31.0", "~> 5.80"));
assert.ok(satisfies("2.4.1", "~> 2.4") && !satisfies("3.0.0", "~> 2.4") && !satisfies("1.10.5", "~> 1.5.0"));

const ids = new Set();
for (const s of SCENARIOS) {
  assert.ok(!ids.has(s.id), `${s.id}: unique id`);
  ids.add(s.id);
  const w = new World(s);
  assert.ok(!won(w), `${s.id}: must start broken`);
  assert.strictEqual(s.hints.length, 3, `${s.id}: three hints`);
  for (const k of ["title", "story", "goal", "done", "lesson", "group", "level"]) assert.ok(s[k], `${s.id}: ${k}`);
  const c = s.check(w);
  assert.ok(c.label && typeof c.ok === "boolean" && c.text !== undefined, `${s.id}: live check`);
  for (const cmd of s.tries) assert.ok(shell(w, cmd).length > 0, `${s.id}: "${cmd}" prints something`);
  // Every file a scenario ships is valid HCL in terraform fmt style, except the one about fmt.
  for (const [f, text] of Object.entries(new World(s).fs)) {
    if (!/\.(tf|tfvars)$/.test(f) || f.startsWith(".terraform/")) continue;
    if (s.id === "fmtcheck" && f === "main.tf") { assert.notStrictEqual(H.format(text), text); continue; }
    assert.strictEqual(H.format(text), text, `${s.id}: ${f} is canonical`);
  }
}
assert.ok(SCENARIOS.length >= 49, "at least 49 scenarios");

// State: removed, moved, taint.
{
let w = fresh("removed");
sub(w,"main.tf",'\nresource "aws_s3_bucket" "archive" {\n  bucket        = "quest-archive-2019"\n  force_destroy = true\n}\n','');
run(w,"terraform apply -auto-approve"); assert(!won(w)); quiet("removed wrong ok", w.scenario.check(w).text);
w = fresh("removed");
sub(w,"main.tf",'resource "aws_s3_bucket" "archive" {\n  bucket        = "quest-archive-2019"\n  force_destroy = true\n}','removed {\n  from = aws_s3_bucket.archive\n\n  lifecycle {\n    destroy = false\n  }\n}');
run(w,"terraform plan",1); run(w,"terraform apply -auto-approve"); run(w,"terraform plan"); assert(won(w), "removed fix");
w = fresh("moved"); run(w,"terraform plan"); 
w.fs["main.tf"] += '\nmoved {\n  from = aws_instance.web\n  to   = aws_instance.app\n}\n';
run(w,"terraform plan",1); run(w,"terraform apply -auto-approve"); assert(won(w),"moved");
w = fresh("moved"); run(w,"terraform apply -auto-approve"); assert(!won(w)); quiet(w.scenario.check(w).text);
w = fresh("moved"); run(w,"terraform state mv aws_instance.web aws_instance.app",1); assert(won(w));
w = fresh("taint"); run(w,"terraform apply -auto-approve"); assert(!won(w)); run(w,"terraform apply -replace=aws_instance.api -auto-approve",1); assert(won(w),"taint");
w = fresh("taint"); run(w,"terraform taint aws_instance.api"); run(w,"terraform apply -auto-approve"); assert(won(w),"taint2");
}

// Plans: a rename that replaces the database.
{
let w = fresh("dbreplace");
run(w,"terraform plan",1);
run(w,"terraform apply -auto-approve"); assert(!won(w)); quiet(w.scenario.check(w));
w = fresh("dbreplace");
sub(w,"main.tf",'  tags = {','  lifecycle {\n    prevent_destroy = true\n  }\n\n  tags = {');
quiet(run(w,"terraform plan").split("\n").slice(-12).join("\n"));
sub(w,"main.tf",'"orders-db-prod"','"orders-db"');
run(w,"terraform apply -auto-approve",1); assert(won(w),"db fix");
}

// create_before_destroy.
{
let w = fresh("cbd");
quiet(run(w,"terraform apply -auto-approve").split("\n").slice(-12).join("\n")); assert(!won(w));
w = fresh("cbd");
sub(w,"main.tf",'  vpc_id      = "vpc','  vpc_id      = "vpc');
sub(w,"main.tf",'  ingress {','  lifecycle {\n    create_before_destroy = true\n  }\n\n  ingress {');
quiet(run(w,"terraform apply -auto-approve").split("\n").slice(-10).join("\n")); assert(!won(w));
w = fresh("cbd");
sub(w,"main.tf",'name        = "web"','name_prefix = "web-"');
sub(w,"main.tf",'  ingress {','  lifecycle {\n    create_before_destroy = true\n  }\n\n  ingress {');
run(w,"terraform apply -auto-approve",1); assert(won(w),"cbd fix");
}

// count to for_each, -target, ignore_changes.
{
let w;
w = fresh("countshift");
sub(w,"main.tf","count         = length(var.teams)","for_each      = var.teams");
quiet(run(w,"terraform plan").split("\n").slice(0,12).join("\n"));
sub(w,"main.tf","for_each      = var.teams","for_each      = toset(var.teams)");
sub(w,"main.tf","${var.teams[count.index]}","${each.key}");
w.fs["main.tf"] += '\nmoved {\n  from = aws_instance.runner[1]\n  to   = aws_instance.runner["bob"]\n}\n\nmoved {\n  from = aws_instance.runner[2]\n  to   = aws_instance.runner["carol"]\n}\n';
run(w,"terraform apply -auto-approve"); assert(won(w),"countshift fix");
w = fresh("target"); run(w,"terraform apply -auto-approve -target=aws_instance.app"); assert(!won(w)); run(w,"terraform apply -auto-approve"); assert(!won(w)); run(w,"terraform plan"); assert(won(w),"target");
w = fresh("ignorechanges"); run(w,"terraform apply -refresh-only -auto-approve"); run(w,"terraform plan"); assert(!won(w));
sub(w,"main.tf","  launch_template {","  lifecycle {\n    ignore_changes = [desired_capacity]\n  }\n\n  launch_template {"); run(w,"terraform plan",1); assert(won(w),"ignore");
w = fresh("ignorechanges"); sub(w,"main.tf","desired_capacity    = 2","desired_capacity    = 6"); run(w,"terraform plan"); assert(!won(w), "hardcode 6 not a fix");
w = fresh("ignorechanges"); run(w,"terraform apply -auto-approve"); assert(!won(w)); quiet(w.scenario.check(w));
}

// cycles and teardown.
{
let w = fresh("cycle");
run(w,"terraform plan",1);
w.fs["main.tf"] = `resource "aws_security_group" "app" {
  name   = "app"
  vpc_id = "vpc-0a1b2c3d4e5f60718"
}

resource "aws_security_group" "db" {
  name   = "db"
  vpc_id = "vpc-0a1b2c3d4e5f60718"
}

resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
`;
run(w,"terraform apply -auto-approve"); assert(won(w),"cycle fix");
w = fresh("cycle"); sub(w,"main.tf",'  name   = "db"','  name       = "db"\n  depends_on = [aws_security_group.app]'); assert(/Cycle/.test(run(w,"terraform plan")));
w = fresh("teardown"); run(w,"terraform destroy -auto-approve",1); assert(!won(w));
run(w,"terraform state rm aws_db_instance.loadtest"); run(w,"terraform destroy -auto-approve"); assert(!won(w)); quiet(w.scenario.check(w));
w = fresh("teardown"); sub(w,"main.tf","deletion_protection         = true","deletion_protection         = false"); run(w,"terraform apply -auto-approve"); run(w,"terraform destroy -auto-approve",1); assert(won(w),"teardown");
}

// CI variables, tfvars precedence, module pins.
{
let w = fresh("varci");
quiet(run(w,"ci run").split("\n").slice(-16).join("\n")); assert(!won(w));
sub(w,".github/workflows/terraform.yml","      AWS_REGION: eu-west-1","      AWS_REGION: eu-west-1\n      TF_VAR_environment: staging");
quiet(run(w,"ci run").split("\n").slice(-6).join("\n")); assert(won(w),"varci");
w = fresh("varci"); sub(w,"variables.tf","type        = string","type        = string\n  default     = \"dev\""); run(w,"ci run"); assert(!won(w), "default dev");
w = fresh("tfvarsprec"); quiet(run(w,"terraform plan").split("\n").filter(l=>/instance_type|Plan/.test(l)).join("\n"));
run(w,"export TF_VAR_instance_type=t3.large"); run(w,"terraform plan"); assert(!won(w)); run(w,"rm dev.auto.tfvars"); run(w,"terraform plan"); assert(won(w),"tfvars");
w = fresh("modpin"); quiet(run(w,"terraform plan")); run(w,"terraform init"); assert(!/Success/.test(run(w,"terraform validate")));
sub(w,"main.tf",'source = "quest-modules/vpc/aws"','source  = "quest-modules/vpc/aws"\n  version = "~> 2.4"');
quiet(run(w,"terraform plan").split("\n").slice(0,8).join("\n")); quiet(run(w,"terraform init").split("\n").slice(0,4).join("\n")); run(w,"terraform plan",1); assert(won(w),"modpin");
}

// modules, for_each and data sources.
{
let w = fresh("modoutput"); quiet(run(w,"terraform validate"));
sub(w,"main.tf","module.network.subnet_id","module.network.private_subnet_ids[0]"); run(w,"terraform apply -auto-approve"); assert(won(w),"modoutput");
w = fresh("modoutput"); sub(w,"main.tf","module.network.subnet_id",'"subnet-0d1e2f3a4b5c6d7e8"'); run(w,"terraform apply -auto-approve"); assert(!won(w));
w = fresh("foreachunknown"); quiet(run(w,"terraform plan").split("\n").slice(0,8).join("\n"));
run(w,"terraform apply -auto-approve -target=aws_subnet.private"); run(w,"terraform apply -auto-approve"); quiet(w.scenario.check(w)); assert(!won(w),"target workaround is not a fix");
w = fresh("foreachunknown");
w.fs["main.tf"] = `locals {
  subnets = {
    a = "10.0.10.0/24"
    b = "10.0.11.0/24"
  }
}

resource "aws_subnet" "private" {
  for_each   = local.subnets
  vpc_id     = "vpc-0a1b2c3d4e5f60718"
  cidr_block = each.value
}

resource "aws_instance" "worker" {
  for_each      = aws_subnet.private
  ami           = "ami-0c1d2e3f4a5b6c7d8"
  instance_type = "t3.small"
  subnet_id     = each.value.id
}
`;
quiet(run(w,"terraform apply -auto-approve").split("\n").slice(-3).join("\n")); assert(won(w),"foreach fix");
w = fresh("datanotfound"); quiet(run(w,"terraform plan"));
sub(w,"main.tf",'Name = "shop-${var.environment}"','Name = "shop-vpc-${var.environment}"'); run(w,"terraform apply -auto-approve"); assert(won(w),"data");
w = fresh("datanotfound"); sub(w,"main.tf",'Name = "shop-${var.environment}"',''); quiet(run(w,"terraform plan").split("\n").slice(0,3).join("\n"));
w = fresh("dependson"); quiet(run(w,"terraform plan"));
run(w,"terraform apply -auto-approve -target=module.network"); run(w,"terraform apply -auto-approve"); assert(!won(w)); quiet(w.scenario.check(w));
w = fresh("dependson"); sub(w,"main.tf","\n  depends_on = [module.network]",""); quiet(run(w,"terraform plan").split("\n").filter(l=>/#|Plan/.test(l)).join("\n")); run(w,"terraform apply -auto-approve"); assert(won(w),"dependson");
}

// instance keys and validation.
{
let w = fresh("instancekey"); quiet(run(w,"terraform validate"));
sub(w,"outputs.tf","aws_instance.bastion.private_ip","aws_instance.bastion[0].private_ip"); run(w,"terraform apply -auto-approve"); quiet(w.scenario.check(w)); assert(!won(w),"[0] fails without bastion");
w = fresh("instancekey"); sub(w,"outputs.tf","aws_instance.bastion.private_ip","one(aws_instance.bastion[*].private_ip)"); run(w,"terraform apply -auto-approve",1); assert(won(w),"instancekey");
w = fresh("validation"); quiet(run(w,"terraform plan"));
sub(w,"variables.tf",'["dev", "staging", "prod"]','["dev", "staging", "prod", "production"]'); run(w,"terraform plan"); assert(!won(w));
w = fresh("validation"); run(w,"export TF_VAR_environment=prod"); run(w,"terraform plan"); assert(won(w),"validation");
}

// providers and versions.
{
let w = fresh("provconflict"); quiet(last(run(w,"terraform init"),9)); run(w,"terraform init -upgrade"); assert(!won(w));
sub(w,"main.tf",'source = "quest-modules/storage/aws"','source  = "quest-modules/storage/aws"\n  version = "~> 1.3"'); quiet(last(run(w,"terraform init"),3)); run(w,"terraform plan"); assert(won(w),"provconflict");
quiet(run(w,"terraform providers"));
w = fresh("lockedversion"); quiet(last(run(w,"terraform plan"),10)); quiet(last(run(w,"terraform init"),8)); run(w,"rm -rf .terraform"); run(w,"terraform init"); assert(!won(w));
run(w,"terraform init -upgrade"); run(w,"terraform plan"); assert(won(w),"lockedversion");
w = fresh("requiredversion"); quiet(last(run(w,"terraform plan"),12)); run(w,"tfenv use 1.5.7"); run(w,"terraform plan"); assert(!won(w));
w = fresh("requiredversion"); sub(w,"versions.tf",'"~> 1.5.0"','"~> 1.10"'); run(w,"terraform plan"); assert(won(w),"reqver");
w = fresh("newerstate"); quiet(last(run(w,"terraform plan"),4)); run(w,"terraform init -upgrade"); run(w,"terraform plan"); assert(!won(w));
quiet(run(w,"tfenv install 1.10.5")); run(w,"tfenv use 1.10.5"); run(w,"terraform plan"); assert(won(w),"newer");
w = fresh("platformlock"); quiet(last(run(w,"ci run"),14)); run(w,"terraform init -upgrade"); run(w,"ci run"); assert(!won(w));
run(w,"rm .terraform.lock.hcl"); quiet(last(run(w,"ci run"),2)); assert(!won(w));
w = fresh("platformlock"); quiet(run(w,"terraform providers lock -platform=darwin_arm64 -platform=linux_amd64")); quiet(last(run(w,"ci run"),2)); assert(won(w),"platformlock");
}

// provider aliases, locks, workspaces, backend migration.
{
let w = fresh("provalias"); quiet(last(run(w,"terraform apply -auto-approve"),9)); assert(!won(w));
sub(w,"versions.tf",'provider "aws" {\n  region = "eu-west-1"\n}','provider "aws" {\n  region = "eu-west-1"\n}\n\nprovider "aws" {\n  alias  = "us_east_1"\n  region = "us-east-1"\n}');
sub(w,"main.tf",'  domain_name       = "shop.example.com"','  provider          = aws.us_east_1\n  domain_name       = "shop.example.com"');
quiet(run(w,"terraform apply -auto-approve").split("\n").filter(l=>/#|Plan|complete|Error/.test(l)).join("\n")); assert(won(w),"provalias");
w = fresh("lockstuck"); quiet(run(w,"terraform plan")); run(w,"terraform plan -lock=false"); assert(!won(w));
quiet(run(w,"terraform force-unlock 1234")); quiet(run(w,"yes"));
run(w,"terraform force-unlock b7d1e9a2-5c3f-4e8b-a1d6-0f2c9e4b7a35"); run(w,"yes"); run(w,"terraform plan"); assert(won(w),"lockstuck");
w = fresh("workspace"); quiet(last(run(w,"terraform plan -var ami=ami-0f9e8d7c6b5a4f3e2"),12)); run(w,"terraform apply -auto-approve -var ami=ami-0f9e8d7c6b5a4f3e2"); assert(!won(w));
w = fresh("workspace"); run(w,"terraform workspace select staging"); quiet(run(w,"terraform apply -var ami=ami-0f9e8d7c6b5a4f3e2").split("\n").slice(-6).join("\n")); run(w,"yes"); assert(won(w),"workspace");
w = fresh("backendmigrate"); quiet(last(run(w,"terraform plan"),4)); run(w,"terraform init -reconfigure"); quiet(last(run(w,"terraform plan"),3)); assert(!won(w));
w = fresh("backendmigrate"); quiet(run(w,"terraform init")); quiet(last(run(w,"yes"),12)); run(w,"terraform plan"); assert(won(w),"migrate");
}

// stale plans, locking, backends and security.
{
let w = fresh("staleplan"); quiet(run(w,"terraform apply tfplan")); assert(!won(w)); run(w,"terraform plan -out=tfplan"); run(w,"terraform apply tfplan"); assert(won(w),"stale");
w = fresh("nolock"); run(w,"terraform plan -lock=true"); assert(!won(w));
sub(w,"versions.tf",'key    = "shop/terraform.tfstate"','key    = "shop/terraform.tfstate"\n    dynamodb_table = "tf-locks"');
quiet(last(run(w,"terraform plan"),3)); quiet(run(w,"terraform init")); run(w,"terraform init -reconfigure"); run(w,"terraform plan"); assert(won(w),"nolock");
w = fresh("nolock"); sub(w,"versions.tf",'key    = "shop/terraform.tfstate"','key    = "shop/terraform.tfstate"\n    use_lockfile = true'); run(w,"terraform init -migrate-state"); quiet(last(run(w,"terraform plan"),4)); assert(won(w),"nolock2");
w = fresh("backendbucket"); quiet(run(w,"terraform init")); sub(w,"versions.tf",'"quest-tf-state"','"quest-tfstate"'); run(w,"terraform init"); run(w,"terraform plan"); assert(won(w),"bucket");
w = fresh("sensitiveout"); quiet(run(w,"terraform plan")); sub(w,"variables.tf","\n  sensitive = true",""); run(w,"terraform apply -auto-approve"); assert(!won(w));
w = fresh("sensitiveout"); sub(w,"outputs.tf",'  value = ','  sensitive = true\n  value     = '); run(w,"terraform apply -auto-approve"); assert(won(w),"sens"); quiet(run(w,"terraform output"), run(w,"terraform output database_url"));
w = fresh("dbpassword"); quiet(run(w,"terraform state pull | grep password"));
sub(w,"main.tf",'password            = "changeme-changeme"','password            = var.db_password'); w.fs["variables.tf"]='variable "db_password" {\n  type      = string\n  sensitive = true\n}\n'; run(w,"export TF_VAR_db_password=changeme-changeme"); run(w,"terraform apply -auto-approve"); assert(!won(w));
w = fresh("dbpassword"); sub(w,"main.tf",'password            = "changeme-changeme"','manage_master_user_password = true'); run(w,"terraform fmt"); quiet(run(w,"terraform apply -auto-approve").split("\n").filter(l=>/~|-|\+|Plan/.test(l)).join("\n")); assert(won(w),"dbpw");
w = fresh("openssh"); sub(w,"main.tf",'from_port   = 22\n    to_port     = 22','from_port   = 2222\n    to_port     = 2222'); run(w,"terraform apply -auto-approve"); assert(!won(w));
w = fresh("openssh"); sub(w,"main.tf",'protocol    = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n\n  ingress {\n    from_port   = 443','protocol    = "tcp"\n    cidr_blocks = ["10.20.0.0/16"]\n  }\n\n  ingress {\n    from_port   = 443'); run(w,"terraform apply -auto-approve"); assert(won(w),"ssh");
w = fresh("publicbucket"); quiet(last(run(w,"terraform apply -auto-approve"),9)); assert(!won(w));
w.fs["main.tf"] += '\nresource "aws_s3_bucket_ownership_controls" "reports" {\n  bucket = aws_s3_bucket.reports.id\n\n  rule {\n    object_ownership = "ObjectWriter"\n  }\n}\n'; quiet(last(run(w,"terraform apply -auto-approve"),3)); 
w = fresh("publicbucket"); w.fs["main.tf"] = 'resource "aws_s3_bucket" "reports" {\n  bucket = "quest-partner-reports"\n}\n\nresource "aws_s3_bucket_public_access_block" "reports" {\n  bucket                  = aws_s3_bucket.reports.id\n  block_public_acls       = true\n  block_public_policy     = true\n  ignore_public_acls      = true\n  restrict_public_buckets = true\n}\n'; run(w,"terraform apply -auto-approve"); assert(won(w),"public");
w = fresh("credentials"); sub(w,"versions.tf",'region = "eu-west-1"','region     = "eu-west-1"\n  access_key = "x"\n  secret_key = "y"'); run(w,"terraform plan"); assert(!won(w)); 
w = fresh("credentials"); run(w,"export AWS_PROFILE=quest"); run(w,"terraform plan"); assert(won(w),"creds");
}

// Throttling, timeouts, state recovery, provider upgrades, tests, and rules that fight.
{
let w = fresh("throttling"); quiet(last(run(w,"terraform apply -auto-approve"),9)); run(w,"terraform apply -auto-approve"); assert(!won(w));
w = fresh("throttling"); run(w,"terraform apply -auto-approve -parallelism=2"); assert(won(w),"parallelism");
w = fresh("throttling"); sub(w,"versions.tf","\n  max_retries = 1",""); run(w,"terraform fmt"); run(w,"terraform apply -auto-approve"); assert(won(w),"retries");
w = fresh("timeouts"); quiet(run(w,"terraform plan").split("\n").filter(l=>/#|Plan/.test(l)).join("\n")); run(w,"terraform apply -auto-approve"); assert(!won(w)); quiet(w.scenario.check(w));
w = fresh("timeouts"); quiet(run(w,"terraform untaint aws_db_instance.warehouse")); sub(w,"main.tf","  skip_final_snapshot         = true\n","  skip_final_snapshot         = true\n\n  timeouts {\n    create = \"120m\"\n  }\n"); quiet(last(run(w,"terraform plan"),4)); assert(won(w),"timeouts");
w = fresh("staterecover"); quiet(run(w,"terraform plan").split("\n").filter(l=>/#|Plan/.test(l)).join("\n"));
const vs = JSON.parse(run(w,"aws s3api list-object-versions --bucket quest-tfstate --prefix shop/terraform.tfstate")).Versions; quiet(vs.length);
quiet(run(w,`aws s3api get-object --bucket quest-tfstate --key shop/terraform.tfstate --version-id ${vs[1].VersionId} recovered.tfstate`).slice(0,80));
quiet(run(w,"terraform state push recovered.tfstate")); assert(!won(w));
run(w,"terraform state push -force recovered.tfstate"); quiet(last(run(w,"terraform plan"),4)); assert(won(w),"recover");
w = fresh("staterecover"); quiet(last(run(w,"terraform apply -auto-approve"),8)); assert(!won(w)); quiet(w.scenario.check(w));
w = fresh("awsv5upgrade"); quiet(last(run(w,"terraform plan"),4)); quiet(last(run(w,"terraform init -upgrade"),3));
quiet(run(w,"terraform plan"));
sub(w,"main.tf",'  name                        = "reports"','  db_name                     = "reports"');
sub(w,"main.tf",'  acl    = "private"\n\n  versioning {\n    enabled = true\n  }\n','');
w.fs["main.tf"] += '\nresource "aws_s3_bucket_versioning" "reports" {\n  bucket = aws_s3_bucket.reports.id\n\n  versioning_configuration {\n    status = "Enabled"\n  }\n}\n';
quiet(run(w,"terraform apply -auto-approve").split("\n").filter(l=>/#|Plan|Error|Warn/.test(l)).join("\n")); run(w,"terraform plan"); assert(won(w),"v5");
w = fresh("tftest"); quiet(run(w,"terraform test")); 
sub(w,"tests/naming.tftest.hcl",'"quest-logs-dev"','"quest-logs-data"'); run(w,"terraform test"); assert(!won(w));
w = fresh("tftest"); sub(w,"main.tf","${var.team}\"","${var.environment}\""); quiet(last(run(w,"terraform test"),3)); assert(won(w),"tftest");
w = fresh("perpetualdiff"); quiet(run(w,"terraform plan").split("\n").filter(l=>/#|Plan|from_port/.test(l)).join("\n")); run(w,"terraform apply -auto-approve"); quiet(run(w,"terraform plan").split("\n").filter(l=>/#|Plan/.test(l)).join("\n")); assert(!won(w));
w = fresh("perpetualdiff"); sub(w,"main.tf","    cidr_blocks = [\"10.0.1.0/24\"]\n  }\n","    cidr_blocks = [\"10.0.1.0/24\"]\n  }\n\n  ingress {\n    from_port   = 9187\n    to_port     = 9187\n    protocol    = \"tcp\"\n    cidr_blocks = [\"10.0.50.0/24\"]\n  }\n"); delete w.fs["monitoring.tf"];
quiet(run(w,"terraform apply -auto-approve").split("\n").filter(l=>/#|Plan|Error/.test(l)).join("\n")); quiet(run(w,"terraform plan").split("\n").filter(l=>/#|Plan|No changes/.test(l)).join("\n")); run(w,"terraform apply -auto-approve"); run(w,"terraform plan"); assert(won(w),"perpetual");
w = fresh("perpetualdiff"); sub(w,"main.tf","\n  ingress {\n    from_port   = 5432\n    to_port     = 5432\n    protocol    = \"tcp\"\n    cidr_blocks = [\"10.0.1.0/24\"]\n  }\n",""); w.fs["main.tf"] += '\nresource "aws_vpc_security_group_ingress_rule" "app" {\n  security_group_id = aws_security_group.db.id\n  ip_protocol       = "tcp"\n  from_port         = 5432\n  to_port           = 5432\n  cidr_ipv4         = "10.0.1.0/24"\n}\n'; quiet(last(run(w,"terraform apply -auto-approve"),7));
}

// The first five basics.
let b = fresh("noinit");
assert.match(run(b, "terraform plan"), /Inconsistent dependency lock file/);
run(b, "terraform apply -auto-approve");
assert.ok(!won(b), "apply before init fails too");
run(b, "terraform init");
run(b, "terraform apply");
assert.ok(!won(b), "apply waits for yes");
run(b, "no");
assert.ok(!won(b), "anything but yes cancels");
run(b, "terraform apply");
run(b, "yes");
assert.ok(won(b), "noinit: init then apply");
b = fresh("unsupported");
assert.match(run(b, "terraform validate"), /Did you mean\n│ "instance_type"/);
sub(b, "main.tf", '  instance_typ = "t3.small"\n', "");
run(b, "terraform apply -auto-approve");
assert.ok(!won(b), "deleting the line gets the default size");
b = fresh("unsupported");
run(b, "sed -i 's/instance_typ /instance_type/' main.tf");
run(b, "terraform apply -auto-approve");
assert.ok(won(b), "unsupported: fixed name");
b = fresh("invalidref");
assert.match(run(b, "terraform validate"), /Invalid reference/);
sub(b, "main.tf", "reports-${env}", "reports-env");
run(b, "terraform apply -auto-approve");
assert.ok(!won(b), "a literal is not the variable");
b = fresh("invalidref");
run(b, "sed -i 's/${env}/${var.env}/' main.tf");
run(b, "terraform apply -auto-approve");
assert.ok(won(b), "invalidref");
b = fresh("fmtcheck");
assert.match(run(b, "ci run"), /CI failed/);
run(b, "terraform validate");
run(b, "terraform fmt -check");
run(b, "ci run");
assert.ok(!won(b), "validate and fmt -check change nothing");
run(b, "terraform fmt");
assert.match(run(b, "ci run"), /CI passed/);
assert.ok(won(b), "fmtcheck");
b = fresh("outputmissing");
assert.match(run(b, "terraform output"), /No outputs found/);
run(b, "terraform plan");
assert.ok(!won(b), "a plan does not save outputs");
run(b, "terraform apply -refresh-only -auto-approve");
assert.ok(won(b), "outputmissing");

// Shell and CLI details the scenarios rely on.
b = fresh("drift");
assert.match(run(b, "terraform state list"), /aws_security_group\.web/);
assert.match(run(b, "terraform state show aws_security_group.web"), /# aws_security_group\.web:/);
assert.match(run(b, "terraform workspace list"), /\* default/);
assert.match(run(b, "terraform version"), /Terraform v1\.10\.5/);
assert.match(run(b, "terraform nope"), /has no command named "nope"/);
assert.match(run(b, "echo 'var.x' | terraform console"), /undeclared|Unsupported attribute/);
run(b, "terraform console");
assert.match(run(b, 'upper("ok")'), /"OK"/);
run(b, "exit");
assert.match(run(b, "terraform graph"), /digraph/);
assert.match(run(b, "bogus"), /command not found/);
assert.match(run(b, "cat nope.tf"), /No such file/);
assert.match(run(b, "tofu plan"), /OpenTofu/);

// The cheat sheet: each command marked Try runs as written in its scenario,
// and each one left to the lab really cannot run here.
global.window = {};
require(path.resolve(__dirname, "../site/data.js"));
const Q = window.QUEST;
const runsIn = (id, cmd) => {
  const w = fresh(id);
  const full = fillBlanks(w, cmd);
  if (/<[^>]+>/.test(full)) return false;
  const res = shell(w, full);
  return !res.some(([t, k]) => k === "na" || /command not found|Error:|No such file/.test(t));
};
for (const [cmd, , , where] of Q.cheats) {
  if (where) assert.ok(runsIn(where, cmd), `cheat sheet: "${cmd}" should run in ${where}`);
  else assert.ok(!SCENARIOS.some((s) => runsIn(s.id, cmd)), `cheat sheet: "${cmd}" now runs in the playground; give it a Try`);
}

// Scenarios name real levels; Troubleshoot links only to scenarios that exist.
for (const s of SCENARIOS) assert.ok(Q.levels.some((l) => l.id === s.level), `${s.id}: level ${s.level}`);
for (const d of Q.problems) for (const id of d.practise) assert.ok(ids.has(id), `problem ${d.id} links to unknown scenario ${id}`);

console.log(`playground ok: ${SCENARIOS.length} scenarios`);
