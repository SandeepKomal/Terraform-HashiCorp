# Security

This repository contains infrastructure examples that can create real AWS resources.

## Before applying

- Never commit AWS access keys, secret keys, private keys, passwords, or tokens.
- Review every security group before applying it.
- Prefer private subnets for databases and internal workloads.
- Use IAM roles instead of long-lived access keys.
- Run `terraform plan` and review the changes before `apply`.
- Destroy temporary resources when finished.

## Reporting a security issue

Do not publish credentials or sensitive infrastructure details in a public issue. Contact the repository owner privately through GitHub.
