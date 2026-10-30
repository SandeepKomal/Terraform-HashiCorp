# Terraform HashiCorp — AWS Infrastructure Examples

A practical collection of Terraform examples for learning and demonstrating AWS infrastructure as code, including networking, compute, storage, databases, load balancing, IAM, ECR, EKS, ECS/Fargate, and ECS on EC2.

> **Learning repository:** Most directories are standalone examples. Review variables and security settings before applying anything to an AWS account.

## Terraform Quest: learn by fixing

**[Terraform Quest](https://sandeepkomal.github.io/Terraform-HashiCorp/)** is the free learning site for this repository, built from `site/`:

- a **playground**: a `terraform` CLI in the browser over a modelled configuration, state and AWS account, with 49 incidents (state locks and recovery, drift, replacements, imports, modules, provider upgrades, API limits, tests, CI and security), each with hints and wrong moves that do not fix it;
- an **HCL X-ray** that explains every line of a `.tf` file and flags risky settings;
- a **troubleshooting reference** for the common Terraform errors, also as plain HTML in [`site/problems.html`](site/problems.html);
- a 16-level path that links these examples, a quiz, a cheat sheet and an architecture diagram.

Nothing is installed and nothing leaves the browser. The commands are the same with [OpenTofu](https://opentofu.org) (`tofu`). Run the checks with `node tests/check_playground.js` (and the other files in `tests/`); after changing the troubleshooting entries, run `node tools/build-problems.js`.

## What is included

| Directory | Topic |
|---|---|
| `tf-vpc` | VPC, public/private subnets, NAT gateways |
| `tf-ec2` | EC2 instance |
| `tf-ebs` | EBS volume and attachment |
| `tf-efs` | EFS filesystem |
| `tf-alb` | Application Load Balancer |
| `tf-nlb` | Network Load Balancer |
| `tf-asg` | EC2 Auto Scaling |
| `tf-rds` | RDS |
| `tf-sg` | Security groups |
| `tf-iam` | IAM role and instance profile |
| `tf-ecr` | ECR repository |
| `tf-k8s` | EKS cluster and managed node group |
| `ECS` | ECS Fargate |
| `ECS-EC2` | ECS using EC2 capacity |
| `tf-ud` | EC2 user-data example |

## Terraform workflow

Run commands **inside the example directory you want to use**:

```bash
terraform fmt -recursive
terraform init
terraform validate
terraform plan
terraform apply
```

Use `terraform apply -auto-approve` only when you intentionally want to skip the confirmation prompt.

Destroy only resources you created for the example:

```bash
terraform destroy
```

## Authentication

Do not put AWS access keys in Terraform files. Prefer an AWS CLI profile, environment variables, or an IAM role:

```bash
aws configure
aws sts get-caller-identity
```

For examples with required variables, create a local `terraform.tfvars` file. It is ignored by Git.

## Validation and security

The repository CI checks Terraform formatting, validation, and security scanning. Local tools that are useful for deeper checks:

- Terraform
- TFLint
- Trivy
- Checkov

Examples should avoid hard-coded account-specific IDs, passwords, private keys, and credentials.

The Trivy scan in CI blocks on HIGH and CRITICAL findings. The few findings that are the point of an example (a public load balancer, an HTTP listener without a domain, HTTPS-only egress for downloads, the public subnets of the VPC example, a CIDR-limited EKS endpoint) are listed with a reason in [`.trivyignore.yaml`](.trivyignore.yaml).

## Recommended learning path

1. `tf-vpc`
2. `tf-sg`
3. `tf-ec2`
4. `tf-alb` + `tf-asg`
5. `tf-ebs` / `tf-efs`
6. `tf-rds`
7. `tf-iam` + `tf-ecr`
8. `tf-k8s`
9. `ECS`
10. `ECS-EC2`

## Important AWS cost note

NAT gateways, RDS, EKS, ECS/EC2, ALBs, EBS, and other AWS resources can incur charges. Use small development configurations and destroy resources when finished.

## Contributing

Keep examples self-contained, parameterized, formatted, and safe for a fresh AWS account. Never commit credentials or real environment state.

## License

MIT, see [LICENSE](LICENSE). This repository is intended for learning and experimentation. Review each example before production use.

Terraform® and HashiCorp® are trademarks of HashiCorp, Inc. This project is independent and not affiliated with HashiCorp.
