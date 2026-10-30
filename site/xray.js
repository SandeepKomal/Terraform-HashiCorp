// Explains a pasted Terraform file line by line, offline: every block and
// argument gets a note, risky settings are flagged, and missing essentials are
// listed. Uses the shared HCL parser. tests/check_xray.js drives it under Node.
"use strict";

(function (root) {
  const H = root.TQHCL;
  const MAX_LINES = 600;

  const BLOCKS = {
    terraform: "Settings for Terraform itself: the CLI versions it accepts, the providers it needs and where state is stored.",
    required_providers: "Each provider this configuration needs, with its source address and a version constraint.",
    backend: "Where state is stored. A remote backend (S3, GCS, azurerm, HCP Terraform) lets a team and CI share it, with locking.",
    cloud: "Connects this configuration to HCP Terraform or Terraform Enterprise, which then store state and run plans.",
    provider: "Configures a provider: region, credentials source, default tags. One block per account and region; add alias for more.",
    variable: "An input variable. Give it a type and a description; mark it sensitive if it holds a secret.",
    locals: "Named values computed inside the module, to avoid repeating expressions.",
    output: "A value this module exposes: printed after apply, readable with terraform output, and visible to a parent module.",
    resource: "Something Terraform creates and manages. Its address (TYPE.NAME) links it to the real object in state.",
    data: "Reads something that already exists, during plan. It must match exactly one object.",
    module: "Calls a module: a reusable set of resources with its own inputs and outputs.",
    moved: "Records that an address changed (a rename or a move into a module), so the object is kept instead of replaced.",
    import: "Brings an existing object under Terraform at the given address. It shows up in a plan as \"will be imported\".",
    removed: "Stops managing an object. With lifecycle { destroy = false } the real object is kept.",
    lifecycle: "Changes how Terraform replaces or destroys this resource.",
    validation: "A rule the variable's value must pass; the error_message is shown when it fails.",
    ingress: "An inbound rule: which ports, protocol and sources may connect.",
    egress: "An outbound rule. A Terraform-managed group has no egress unless you declare it.",
    dynamic: "Generates repeated nested blocks from a collection.",
    provisioner: "Runs a script during create or destroy. A last resort: it is not tracked in state and failures taint the resource.",
    check: "An assertion checked after apply; failures are warnings, not errors.",
    precondition: "A condition checked before the resource is planned.",
    postcondition: "A condition checked after the resource is applied.",
    filter: "Narrows a data source's search by name and values.",
    statement: "One statement of an IAM policy document.",
    viewer_certificate: "The TLS certificate CloudFront presents. ACM certificates must be in us-east-1.",
    launch_template: "Which launch template (and version) new instances use.",
    rule: "One rule of the parent setting.",
    versioning_configuration: "Turns S3 versioning on or suspends it.",
    root_block_device: "The instance's root disk: size, type and encryption.",
    ebs_block_device: "An extra EBS disk attached at launch.",
    tag: "One tag, with propagate_at_launch for Auto Scaling groups.",
    scaling_configuration: "How many nodes the node group runs: desired, minimum and maximum.",
    vpc_config: "Which subnets and security groups the cluster uses.",
    container_definitions: "The containers in the task, as JSON."
  };

  const TYPES = {
    aws_s3_bucket: "An S3 bucket. Names are global across all AWS accounts. Settings such as versioning and public access are separate resources.",
    aws_s3_bucket_acl: "An S3 bucket ACL. New buckets disable ACLs; prefer bucket policies.",
    aws_s3_bucket_policy: "An S3 bucket policy: who may do what with the bucket.",
    aws_s3_bucket_public_access_block: "Blocks public ACLs and policies on one bucket. Add one to every bucket.",
    aws_s3_bucket_versioning: "Keeps previous versions of objects in a bucket.",
    aws_s3_bucket_server_side_encryption_configuration: "Default encryption for new objects in a bucket.",
    aws_instance: "An EC2 virtual machine.",
    aws_launch_template: "A template of instance settings for Auto Scaling and EC2.",
    aws_autoscaling_group: "Keeps a number of instances running across subnets.",
    aws_db_instance: "An RDS database instance. Stateful: read every replacement in a plan carefully.",
    aws_security_group: "A stateful firewall attached to instances, load balancers and databases.",
    aws_security_group_rule: "One rule of a security group, managed separately.",
    aws_vpc_security_group_ingress_rule: "One inbound rule of a security group, as its own resource.",
    aws_vpc_security_group_egress_rule: "One outbound rule of a security group, as its own resource.",
    aws_vpc: "A virtual network.",
    aws_subnet: "A range of the VPC in one availability zone.",
    aws_internet_gateway: "Connects a VPC to the internet.",
    aws_nat_gateway: "Lets private subnets reach the internet. Billed per hour and per GB.",
    aws_eip: "A static public IP address.",
    aws_route_table: "Routes for the subnets associated with it.",
    aws_route_table_association: "Associates a subnet with a route table.",
    aws_iam_role: "An IAM role that services or users can assume.",
    aws_iam_policy: "A managed IAM policy.",
    aws_iam_role_policy_attachment: "Attaches a managed policy to a role.",
    aws_iam_role_policy: "An inline policy on one role.",
    aws_iam_instance_profile: "Lets an EC2 instance use a role.",
    aws_lb: "An application or network load balancer.",
    aws_lb_target_group: "Where a load balancer sends traffic, with health checks.",
    aws_lb_listener: "A port and protocol the load balancer listens on.",
    aws_ecs_cluster: "An ECS cluster.",
    aws_ecs_service: "Keeps a number of ECS tasks running.",
    aws_ecs_task_definition: "The containers, CPU and memory of an ECS task.",
    aws_ecs_capacity_provider: "Links an Auto Scaling group to ECS capacity.",
    aws_ecr_repository: "A container image registry.",
    aws_eks_cluster: "A managed Kubernetes control plane.",
    aws_eks_node_group: "Managed worker nodes for EKS.",
    aws_ebs_volume: "A block storage volume.",
    aws_volume_attachment: "Attaches an EBS volume to an instance.",
    aws_efs_file_system: "A shared NFS file system.",
    aws_efs_mount_target: "Makes an EFS file system reachable in one subnet.",
    aws_cloudwatch_log_group: "A CloudWatch Logs group. Set retention_in_days, or logs are kept forever.",
    aws_appautoscaling_target: "Registers something (an ECS service) for Application Auto Scaling.",
    aws_appautoscaling_policy: "A scaling policy for Application Auto Scaling.",
    aws_cloudwatch_metric_alarm: "An alarm on a CloudWatch metric.",
    aws_kms_key: "A KMS encryption key.",
    aws_dynamodb_table: "A DynamoDB table.",
    aws_acm_certificate: "A TLS certificate from ACM.",
    aws_cloudfront_distribution: "A CloudFront CDN distribution.",
    aws_ami: "Looks up a machine image (data source).",
    aws_availability_zones: "Lists the availability zones of the region (data source).",
    aws_caller_identity: "The account and identity Terraform runs as (data source).",
    aws_iam_policy_document: "Builds IAM policy JSON in HCL (data source).",
    random_password: "Generates a password; the result is stored in state."
  };

  const ARGS = {
    count: "Creates this many copies, addressed [0], [1], ... Good for identical copies; removing one shifts the rest.",
    for_each: "Creates one instance per map key or set element, addressed by key. Keys must be known at plan time.",
    depends_on: "Explicit dependencies Terraform cannot see from references. Use sparingly; on modules it can defer data sources.",
    provider: "Which provider configuration (alias) to use, for example aws.us_east_1.",
    tags: "Key/value labels on the object. Used for cost, ownership and automation.",
    name: "The object's name in AWS. Often unique per account or VPC, and often forces replacement when changed.",
    name_prefix: "A prefix; AWS adds a unique suffix. Lets create_before_destroy create a replacement without a name clash.",
    description: "Free text for people. On some resources (security groups) changing it forces replacement.",
    region: "The AWS region this provider configuration talks to.",
    alias: "A second configuration of the same provider, referenced as provider = aws.<alias>.",
    profile: "The AWS CLI profile to read credentials from. Better set with AWS_PROFILE than in code.",
    source: "Where the provider or module comes from: a registry address, a local path (./modules/x) or a Git URL.",
    version: "A version constraint, for example ~> 5.0 (>= 5.0, < 6.0). Pin modules and providers.",
    required_version: "Which Terraform CLI versions may run this configuration.",
    bucket: "The bucket name (S3 names are global), or the bucket this setting applies to.",
    key: "The path of the state file inside the bucket.",
    encrypt: "Encrypts the state object at rest. State holds secrets: keep this true.",
    dynamodb_table: "A DynamoDB table that holds the state lock.",
    use_lockfile: "Native S3 state locking (Terraform 1.10+), without DynamoDB.",
    type: "The variable's type: string, number, bool, list(...), map(...), object({...}).",
    default: "The value used when nothing else sets the variable. Without a default the variable is required.",
    sensitive: "Hides the value in plan and apply output. It is still stored in state.",
    nullable: "Whether null is an acceptable value.",
    value: "The output's value.",
    condition: "Must be true for the value to be accepted.",
    error_message: "Shown when the condition fails.",
    prevent_destroy: "Terraform rejects any plan that would destroy this resource, including replacements.",
    create_before_destroy: "On replacement, create the new object first, then destroy the old one.",
    ignore_changes: "Attributes Terraform should leave alone after creation, for example ones an autoscaler manages.",
    replace_triggered_by: "Replaces this resource when the referenced resource changes.",
    ami: "The machine image the instance boots. Changing it replaces the instance.",
    instance_type: "The instance size, which sets CPU, memory and cost.",
    subnet_id: "The subnet (and so the AZ and route table) the object goes in.",
    vpc_id: "The VPC this object belongs to. Changing it forces replacement.",
    vpc_security_group_ids: "The security groups attached to the instance or database.",
    security_groups: "Security groups allowed as sources or targets.",
    key_name: "The EC2 key pair for SSH. Prefer Session Manager to SSH keys.",
    user_data: "A script run on first boot. Do not put secrets in it; it is readable from the instance metadata.",
    associate_public_ip_address: "Gives the instance a public IP. Usually only for public subnets.",
    iam_instance_profile: "The role the instance runs as. Reference the profile resource so the order is right.",
    cidr_block: "The IP range of the VPC or subnet.",
    cidr_blocks: "Source or destination IP ranges for this rule.",
    cidr_ipv4: "The IPv4 range this rule allows.",
    ipv6_cidr_blocks: "IPv6 ranges for this rule.",
    from_port: "First port of the range.",
    to_port: "Last port of the range.",
    protocol: "tcp, udp, icmp, or -1 for all.",
    ip_protocol: "tcp, udp, icmp, or -1 for all.",
    security_group_id: "The group this rule belongs to.",
    referenced_security_group_id: "Allows traffic from or to members of another security group.",
    map_public_ip_on_launch: "Instances launched here get a public IP automatically: makes this a public subnet.",
    availability_zone: "The availability zone. Changing it forces replacement.",
    enable_dns_hostnames: "Gives instances DNS names inside the VPC.",
    enable_dns_support: "Turns on the Amazon DNS server for the VPC.",
    domain: "vpc for an Elastic IP in a VPC.",
    allocation_id: "The Elastic IP the NAT gateway uses.",
    identifier: "The database instance name. Changing it replaces the database.",
    engine: "The database engine, for example postgres or mysql.",
    engine_version: "The engine version. Major upgrades may need allow_major_version_upgrade.",
    instance_class: "The database size.",
    allocated_storage: "Storage in GiB.",
    storage_type: "gp3, gp2 or io1/io2 storage.",
    db_name: "The initial database name.",
    username: "The master user name.",
    password: "The master password. Comes from a sensitive variable at least; better, manage_master_user_password = true.",
    manage_master_user_password: "RDS creates and rotates the password in Secrets Manager; it never enters Terraform state.",
    storage_encrypted: "Encrypts the database storage. Changing it replaces the database.",
    publicly_accessible: "Gives the database a public endpoint. Keep it false.",
    multi_az: "A standby in another AZ for failover.",
    backup_retention_period: "Days of automated backups. 0 disables them.",
    skip_final_snapshot: "If true, deleting (or replacing) the database takes no final snapshot.",
    final_snapshot_identifier: "Name of the snapshot taken when the database is deleted.",
    deletion_protection: "AWS refuses to delete the database while this is true.",
    acl: "A canned ACL. New buckets disable ACLs; public-read makes objects public.",
    force_destroy: "Lets a destroy delete every object in the bucket first.",
    block_public_acls: "Rejects requests that add public ACLs.",
    block_public_policy: "Rejects bucket policies that grant public access.",
    ignore_public_acls: "Ignores any public ACLs that exist.",
    restrict_public_buckets: "Limits access to buckets with public policies to AWS services and the owner.",
    policy: "A JSON policy document. Build it with jsonencode or aws_iam_policy_document.",
    assume_role_policy: "Who may assume the role (the trust policy).",
    role: "The IAM role this attaches to.",
    policy_arn: "The managed policy to attach.",
    min_size: "Fewest instances the group runs.",
    max_size: "Most instances the group runs.",
    desired_capacity: "How many instances to run now. If an autoscaler manages it, add it to ignore_changes.",
    vpc_zone_identifier: "The subnets the group launches into.",
    image_id: "The AMI the launch template uses.",
    image_tag_mutability: "MUTABLE lets a tag be overwritten; IMMUTABLE makes each tag point to one image.",
    scan_on_push: "Scans each pushed image for vulnerabilities.",
    retention_in_days: "How long logs are kept. Unset means forever.",
    encrypted: "Encrypts the volume or file system.",
    kms_key_id: "The KMS key used for encryption.",
    size: "Size in GiB.",
    cluster: "The cluster this belongs to.",
    task_definition: "The task definition (family:revision) the service runs.",
    desired_count: "How many tasks the service keeps running.",
    launch_type: "FARGATE or EC2.",
    load_balancer_type: "application or network.",
    internal: "Whether the load balancer is internal-only.",
    port: "The port to listen on or send to.",
    target_type: "instance, ip or lambda.",
    role_arn: "The role the service uses.",
    statement: "Policy statements.",
    effect: "Allow or Deny.",
    actions: "API actions the statement covers. Avoid \"*\".",
    resources: "ARNs the statement covers. Avoid \"*\" where possible.",
    principals: "Who the statement applies to.",
    most_recent: "Picks the newest match. Combined with a broad filter, the AMI can change between plans.",
    owners: "Accounts whose images may match. Always set it for AMI lookups.",
    from: "The old address.",
    to: "The new address.",
    id: "The ID of the existing object to import.",
    destroy: "false keeps the real object when it leaves Terraform's management.",
    enabled: "Whether this is switched on.",
    domain_name: "The domain the certificate covers.",
    validation_method: "How ownership is proven: DNS (recommended) or EMAIL.",
    length: "Number of characters.",
    special: "Whether special characters are included."
  };

  const SECRET = /^(password|secret|secret_key|access_key|token|api_key|private_key|master_password|client_secret)$/;
  const ADMIN_PORTS = [22, 3389, 3306, 5432, 1433, 27017, 6379, 9200];

  function explain(text) {
    const src = String(text).replace(/\r\n/g, "\n");
    const lines = src.split("\n");
    if (lines.length > MAX_LINES) return { error: `That is ${lines.length} lines; the X-ray reads up to ${MAX_LINES}. Paste one file at a time.` };
    let body;
    try { body = H.parse(src); } catch (e) {
      if (!(e instanceof H.HCLError)) throw e;
      return { error: `Line ${e.line}: ${e.summary}. ${e.detail || ""}`.trim() };
    }
    const rows = lines.map((line) => ({ line, note: null, level: null, warns: [] }));
    const at = (n) => rows[n - 1];
    const review = [];
    const found = { requiredVersion: false, versions: true, backend: null, resources: 0, buckets: [], publicBlock: false, providers: new Set(), dbs: [] };
    const literal = (expr) => expr && expr.k === "lit" && typeof expr.v === "string";
    const valueText = (a) => rows[a.line - 1].line.split("=").slice(1).join("=").trim();

    // Lines a multi-line value spans, so its inner lines can point back at it.
    const spans = [];
    const lastLine = (startLine) => {
      let depth = 0;
      for (let i = startLine - 1; i < lines.length; i++) {
        for (const ch of lines[i].replace(/"(\\.|[^"\\])*"/g, "").replace(/#.*$/, "")) { if ("{[(".includes(ch)) depth++; if ("}])".includes(ch)) depth--; }
        if (depth <= 0) return i + 1;
      }
      return lines.length;
    };

    function attrNote(a, ctx) {
      const r = at(a.line);
      const n = a.name;
      const v = valueText(a);
      r.note = ARGS[n] || (ctx.kind === "variable" || ctx.kind === "module" ? `An input passed to the module: ${n}.` : null);
      if (ctx.kind === "module" && !ARGS[n]) r.note = `An input variable of the module, set to ${v.length > 60 ? "this value" : v}.`;
      if (ctx.kind === "locals") r.note = `A local value, read as local.${n}.`;
      if (ctx.kind === "required_providers") r.note = `The ${n} provider: where it comes from and which versions are allowed.`;
      if (ctx.kind === "tfvars") r.note = `Sets the variable ${n}.`;
      if (!r.note) { r.note = `An argument of this ${ctx.kind === "resource" || ctx.kind === "data" ? ctx.type : ctx.kind} block. It is not in the X-ray's dictionary; check the provider documentation.`; r.level = "unknown"; }
      const end = lastLine(a.line);
      if (end > a.line) spans.push([a.line + 1, end, n]);
      // Risky settings.
      const w = (msg) => r.warns.push(msg);
      if (SECRET.test(n) && literal(a.expr) && a.expr.v) w(`A hard-coded ${n}. It ends up in Git and in state: use a sensitive variable from a secret store, or let the service manage it.`);
      if (/\bAKIA[0-9A-Z]{16}\b/.test(v)) w("This looks like an AWS access key ID. Remove it, rotate it, and use profiles, SSO or OIDC instead.");
      if (ctx.kind === "provider" && (n === "access_key" || n === "secret_key")) w("Credentials in a provider block end up in Git. Use AWS_PROFILE, SSO or an OIDC role.");
      if ((n === "cidr_blocks" || n === "cidr_ipv4" || n === "ipv6_cidr_blocks") && /"(0\.0\.0\.0\/0|::\/0)"/.test(v) && (ctx.kind === "ingress" || /ingress/.test(ctx.type || ""))) {
        const port = ctx.ports && ctx.ports.find((p) => ADMIN_PORTS.includes(p));
        w(port !== undefined ? `Port ${port} open to the whole internet. Limit the source to a VPN or office range, or use Session Manager.` : "Open to the whole internet. Fine for a public load balancer on 80/443; anything else should have a narrower source.");
      }
      if (n === "acl" && /public-read/.test(v)) w("Makes the bucket public. Keep ACLs disabled and share with a bucket policy or presigned URLs.");
      if (/^(block_public_acls|block_public_policy|ignore_public_acls|restrict_public_buckets)$/.test(n) && v === "false") w("Turns off a public access protection.");
      if (n === "publicly_accessible" && v === "true") w("The database gets a public endpoint. Keep databases in private subnets.");
      if ((n === "storage_encrypted" || n === "encrypted" || n === "encrypt") && v === "false") w("Encryption at rest is off.");
      if (n === "skip_final_snapshot" && v === "true") w("No final snapshot when this database is deleted or replaced. Fine for tests, risky for real data.");
      if (n === "deletion_protection" && v === "false") w("Nothing on the AWS side stops this database from being deleted.");
      if (n === "force_destroy" && v === "true") w("A destroy will delete every object in the bucket.");
      if (n === "associate_public_ip_address" && v === "true") w("The instance gets a public IP. Make sure its security group is tight.");
      if (n === "ignore_changes" && /\ball\b/.test(v)) w("ignore_changes = all hides every future change from plans.");
      if (n === "image_tag_mutability" && /MUTABLE"/.test(v) && !/IMMUTABLE/.test(v)) w("Mutable tags let an image be replaced under the same tag. IMMUTABLE makes deployments repeatable.");
      if ((n === "actions" || n === "resources") && /\[\s*"\*"\s*\]/.test(v)) w(`${n} = ["*"] grants everything. List what is needed.`);
      if (n === "source" && ctx.kind === "module") {
        const s = literal(a.expr) ? a.expr.v : "";
        if (/^git::|github\.com\//.test(s) && !/[?&]ref=/.test(s)) w("A Git source without ?ref= follows the default branch: pin a tag or commit.");
        else if (!/^\.\.?\//.test(s) && !/^git::|github\.com\//.test(s) && !ctx.block.attrs.version) w("A registry module without a version argument: init -upgrade can pull a breaking major release. Add version = \"~> X.Y\".");
        if (/^http:\/\//.test(s)) w("Plain HTTP source: use HTTPS.");
      }
      if (ctx.kind === "required_providers" && a.expr.k === "obj" && !a.expr.items.some((it) => (it.key.k === "lit" ? it.key.v : it.key.name) === "version")) {
        found.versions = false;
        w("No version constraint: every init can pick a new major version. Add version = \"~> X.Y\".");
      }
      if (ctx.kind === "required_providers" && literal(a.expr) && !/[\d]/.test(a.expr.v)) found.versions = false;
    }

    function walk(b, parent) {
      const r = at(b.line);
      const [l1, l2] = b.labels;
      const ctx = { kind: b.type, type: l1, block: b, ports: [] };
      if (parent && parent.kind === "resource") ctx.type = parent.type;
      if (b.attrs.from_port && b.attrs.from_port.expr.k === "lit") ctx.ports.push(b.attrs.from_port.expr.v);
      if (b.attrs.to_port && b.attrs.to_port.expr.k === "lit") ctx.ports.push(b.attrs.to_port.expr.v);
      if (b.type === "resource" || b.type === "data") {
        r.note = `${b.type === "data" ? "Data source" : "Resource"} ${l1}.${l2}. ${TYPES[l1] || (b.type === "data" ? `Reads a ${l1.split("_")[0]} object.` : `A ${l1.split("_")[0]} resource of type ${l1}.`)} ${b.type === "data" ? `Referenced as data.${l1}.${l2}.` : `Referenced as ${l1}.${l2}.`}`;
        if (!TYPES[l1]) r.level = "unknown";
        found.providers.add(l1.split("_")[0]);
        if (b.type === "resource") found.resources++;
        if (l1 === "aws_s3_bucket") found.buckets.push(l2);
        if (l1 === "aws_s3_bucket_public_access_block") found.publicBlock = true;
        if (l1 === "aws_db_instance") found.dbs.push(b);
      } else if (BLOCKS[b.type]) {
        r.note = BLOCKS[b.type] + (b.type === "variable" ? ` Read as var.${l1}.` : b.type === "module" ? ` Its outputs are module.${l1}.<name>.` : b.type === "provider" ? ` This one is ${l1}.` : b.type === "backend" ? ` This one is ${l1}.` : "");
      } else if (parent && parent.kind === "resource") {
        r.note = `A nested ${b.type} block of ${parent.type}.`;
      } else { r.note = `A ${b.type} block. It is not in the X-ray's dictionary.`; r.level = "unknown"; }
      if (b.type === "terraform" && b.attrs.required_version) found.requiredVersion = true;
      if (b.type === "backend") {
        found.backend = b;
        if (l1 === "s3" && !b.attrs.dynamodb_table && !b.attrs.use_lockfile) r.warns.push("No state locking: two applies at once can overwrite each other. Add use_lockfile = true (1.10+) or dynamodb_table.");
        if (l1 === "s3" && !b.attrs.encrypt) r.warns.push("encrypt is not set: state holds secrets, so encrypt it at rest (encrypt = true).");
      }
      if (b.type === "variable" && /password|secret|token|key/.test(l1) && !(b.attrs.sensitive && b.attrs.sensitive.expr.v === true)) r.warns.push(`var.${l1} looks like a secret but is not marked sensitive = true.`);
      if (b.type === "output" && /password|secret|token/.test(l1) && !(b.attrs.sensitive && b.attrs.sensitive.expr.v === true)) r.warns.push("An output that looks secret, without sensitive = true.");
      if (b.type === "provisioner") r.warns.push("Provisioners run outside Terraform's model. Prefer user_data, images built in advance, or configuration tools.");
      for (const a of Object.values(b.attrs)) attrNote(a, ctx);
      for (const sub of b.blocks) walk(sub, ctx.kind === "resource" ? ctx : parent || ctx);
      const end = lastLine(b.line);
      if (at(end) && !at(end).note && /^\s*}\s*$/.test(lines[end - 1])) at(end).note = `End of the ${b.type}${l1 ? ` ${l1}` : ""}${l2 ? `.${l2}` : ""} block.`;
    }
    for (const b of body.blocks) walk(b, null);
    // A .tfvars file: top-level arguments only.
    for (const a of Object.values(body.attrs)) attrNote(a, { kind: "tfvars", block: body });

    for (const [from, to, name] of spans) {
      for (let i = from; i <= to; i++) {
        const r = at(i);
        if (r.note || !r.line.trim()) continue;
        r.note = /^\s*[}\])]+,?\s*$/.test(r.line) ? `End of the value of ${name}.` : `Part of the value of ${name} above.`;
        if (/"Action"\s*[:=]\s*"\*"|"Resource"\s*[:=]\s*"\*"/.test(r.line)) r.warns.push("A wildcard in an IAM policy: grant only the actions and resources needed.");
        if (/\bAKIA[0-9A-Z]{16}\b/.test(r.line)) r.warns.push("This looks like an AWS access key ID.");
      }
    }
    rows.forEach((r) => {
      if (!r.note && /^\s*(#|\/\/)/.test(r.line)) r.note = "A comment. Terraform ignores it.";
      if (!r.note && r.line.trim()) { r.note = "Part of the block above."; r.level = "unknown"; }
    });

    // What a production-ready configuration usually has and this file lacks.
    const hasConfig = found.resources > 0 || found.providers.size > 0;
    if (hasConfig && !found.requiredVersion) review.push("No required_version: pin the Terraform versions you test with, for example required_version = \"~> 1.10\".");
    if (hasConfig && (!/required_providers/.test(src) || !found.versions)) review.push("Providers without version constraints in required_providers: every init may pick a new major version.");
    if (found.resources && !found.backend) review.push("No backend block in this file: state stays in a local terraform.tfstate. Use a remote backend with locking for anything shared (it may live in another file).");
    for (const name of found.buckets) if (!found.publicBlock) review.push(`Bucket ${name} has no aws_s3_bucket_public_access_block in this file.`);
    for (const db of found.dbs) {
      const lc = db.blocks.find((x) => x.type === "lifecycle");
      if (!db.attrs.deletion_protection) review.push(`Database ${db.labels[1]} has no deletion_protection = true.`);
      if (!lc || !lc.attrs.prevent_destroy) review.push(`Database ${db.labels[1]} has no lifecycle { prevent_destroy = true }.`);
      if (!db.attrs.storage_encrypted) review.push(`Database ${db.labels[1]} does not set storage_encrypted = true.`);
    }
    return { lines: rows, review };
  }

  root.TQXray = { explain };
})(typeof window !== "undefined" ? window : globalThis);
