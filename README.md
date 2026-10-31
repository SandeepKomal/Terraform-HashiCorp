# DevOps Nimbus Terraform

**Terraform, zero to on-call.** AWS infrastructure examples in Terraform and a free learning site with a `terraform` playground, 49 incidents and a 16-level path, for engineers learning infrastructure as code.

[![Learning site](https://img.shields.io/badge/learn-DevOps%20Nimbus-1d1d1f)](https://sandeepkomal.github.io/Terraform-HashiCorp/)
[![CI](https://github.com/SandeepKomal/Terraform-HashiCorp/actions/workflows/ci.yml/badge.svg)](https://github.com/SandeepKomal/Terraform-HashiCorp/actions/workflows/ci.yml)
[![Terraform Checks](https://github.com/SandeepKomal/Terraform-HashiCorp/actions/workflows/terraform-checks.yml/badge.svg)](https://github.com/SandeepKomal/Terraform-HashiCorp/actions/workflows/terraform-checks.yml)
[![Pages](https://github.com/SandeepKomal/Terraform-HashiCorp/actions/workflows/pages.yml/badge.svg)](https://github.com/SandeepKomal/Terraform-HashiCorp/actions/workflows/pages.yml)
[![Terraform](https://img.shields.io/badge/Terraform-IaC-844FBA?logo=terraform&logoColor=white)](https://developer.hashicorp.com/terraform/docs)
[![AWS](https://img.shields.io/badge/AWS-provider-FF9900)](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
[![Security](https://img.shields.io/badge/security-Trivy%20IaC%20scan-2ea44f)](.github/workflows/terraform-checks.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![No trackers](https://img.shields.io/badge/site-no%20trackers%20%C2%B7%20no%20cookies-2ea44f)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen)](CONTRIBUTING.md)
![Last commit](https://img.shields.io/github/last-commit/SandeepKomal/Terraform-HashiCorp)
[![GitHub stars](https://img.shields.io/github/stars/SandeepKomal/Terraform-HashiCorp?style=social)](https://github.com/SandeepKomal/Terraform-HashiCorp/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/SandeepKomal/Terraform-HashiCorp?style=social)](https://github.com/SandeepKomal/Terraform-HashiCorp/network/members)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/SandeepKomal/Terraform-HashiCorp)

**[Open the learning site](https://sandeepkomal.github.io/Terraform-HashiCorp/)** · [Troubleshoot an error](https://sandeepkomal.github.io/Terraform-HashiCorp/#doctor) · [Every error on one page](https://sandeepkomal.github.io/Terraform-HashiCorp/problems.html) · [All DevOps Nimbus tracks](https://sandeepkomal.github.io/devops-nimbus/)

## Contents

- [Learn it in your browser](#learn-it-in-your-browser)
- [What's in this repository](#whats-in-this-repository)
- [Quick start](#quick-start)
- [Authentication](#authentication)
- [Recommended learning path](#recommended-learning-path)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [Privacy and cost](#privacy-and-cost)
- [License and trademarks](#license-and-trademarks)
- [Author and contributors](#author-and-contributors)

## Learn it in your browser

**[DevOps Nimbus Terraform](https://sandeepkomal.github.io/Terraform-HashiCorp/)** is the free learning site for this repository, built from `site/`:

- a **playground**: a `terraform` CLI in the browser over a modelled configuration, state and AWS account, with 49 incidents (state locks and recovery, drift, replacements, imports, modules, provider upgrades, API limits, tests, CI and security), each with hints and wrong moves that do not fix it;
- an **HCL X-ray** that explains every line of a `.tf` file and flags risky settings;
- a **troubleshooting reference** for the common Terraform errors, also as plain HTML in [`site/problems.html`](site/problems.html);
- a 16-level path that links these examples, a quiz, a cheat sheet and an architecture diagram.
- a **scoreboard**: a score with ranks, a skill radar, learning uptime and on-call shifts against the clock, with Download and Load progress to move it between browsers.

Nothing is installed and nothing leaves the browser. The commands are the same with [OpenTofu](https://opentofu.org) (`tofu`). Run the checks with `node tests/check_playground.js` (and the other files in `tests/`); after changing the troubleshooting entries, run `node tools/build-problems.js`, and after adding or renaming a playground scenario, `node tools/build-scenarios.js`.

## What's in this repository

A practical collection of Terraform examples for learning and demonstrating AWS infrastructure as code, including networking, compute, storage, databases, load balancing, IAM, ECR, EKS, ECS/Fargate, and ECS on EC2.

> **Learning repository:** Most directories are standalone examples. Review variables and security settings before applying anything to an AWS account.

### What is included

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

## Quick start

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

## Repository layout

| Path | What it holds |
| --- | --- |
| `tf-*/`, [ECS/](ECS/), [ECS-EC2/](ECS-EC2/) | One standalone Terraform example per directory |
| [site/](site/) | The DevOps Nimbus Terraform learning site (GitHub Pages) |
| [tests/](tests/) | Tests for the site: playground, fuzzer, HCL X-ray, data, problems.html |
| [tools/](tools/) | Builds site/problems.html from the troubleshooting entries, and site/scenarios.js (the scenario index the first screen reads) from the playground |
| [.github/workflows/](.github/workflows/) | Site tests, Terraform checks with the Trivy scan, Pages deploy |
| [.trivyignore.yaml](.trivyignore.yaml) | Accepted Trivy findings, each with a reason |

## Troubleshooting

- Paste a Terraform error into [Troubleshoot](https://sandeepkomal.github.io/Terraform-HashiCorp/#doctor) on the learning site for its cause, how to confirm it and the fix.
- Every error is also on one plain page: [problems.html](https://sandeepkomal.github.io/Terraform-HashiCorp/problems.html) (source: [site/problems.html](site/problems.html)).

## Contributing

Keep examples self-contained, parameterized, formatted, and safe for a fresh AWS account. Never commit credentials or real environment state.

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the same checks as CI before opening a pull request:

```bash
terraform fmt -check -recursive
terraform -chdir=tf-vpc init -backend=false && terraform -chdir=tf-vpc validate   # each example you changed
trivy config --severity HIGH,CRITICAL --ignorefile .trivyignore.yaml .
for f in site/*.js tools/*.js tests/*.js; do node --check "$f"; done
node tests/check_site_data.js && node tests/check_playground.js && node tests/fuzz_playground.js
node tests/check_xray.js && node tests/check_problems.js
```

## Security

Please report a suspected vulnerability privately, as described in [SECURITY.md](SECURITY.md), rather than in a public issue.

### Validation and security

The repository CI checks Terraform formatting, validation, and security scanning. Local tools that are useful for deeper checks:

- Terraform
- TFLint
- Trivy
- Checkov

Examples should avoid hard-coded account-specific IDs, passwords, private keys, and credentials.

The Trivy scan in CI blocks on HIGH and CRITICAL findings. The few findings that are the point of an example (a public load balancer, an HTTP listener without a domain, HTTPS-only egress for downloads, the public subnets of the VPC example, a CIDR-limited EKS endpoint) are listed with a reason in [`.trivyignore.yaml`](.trivyignore.yaml).

## Privacy and cost

The learning site runs in your browser: no accounts, cookies, trackers or database. Your progress stays in your browser unless you download it as a file. The site is free and hosted on GitHub Pages.

### Important AWS cost note

NAT gateways, RDS, EKS, ECS/EC2, ALBs, EBS, and other AWS resources can incur charges. Use small development configurations and destroy resources when finished. See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## License and trademarks

MIT, see [LICENSE](LICENSE). This repository is intended for learning and experimentation. Review each example before production use.

Terraform® and HashiCorp® are trademarks of HashiCorp, Inc. This project is independent and not affiliated with HashiCorp.

## Author and contributors

**Sandeep Komal** · [github.com/SandeepKomal](https://github.com/SandeepKomal)

Built and maintained with [DevopsNimbus](https://github.com/DevopsNimbus). See everyone who has contributed in the [contributors graph](https://github.com/SandeepKomal/Terraform-HashiCorp/graphs/contributors).

If this helped you, a ⭐ on the repository helps others find it.
