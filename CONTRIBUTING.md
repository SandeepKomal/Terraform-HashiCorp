# Contributing

## Workflow

1. Create a feature branch.
2. Make the smallest focused change.
3. Run `terraform fmt -recursive`.
4. Run `terraform validate` in each changed Terraform root.
5. Run security checks where available.
6. Update the README when adding an example.
7. Open a pull request with a clear summary and testing notes.

## Terraform standards

- Prefer variables over hard-coded AWS IDs and regions.
- Mark sensitive variables as `sensitive = true`.
- Do not commit `.tfstate`, credentials, or local variable files.
- Keep examples understandable and independently runnable.
- Use least-privilege IAM.
- Avoid public network access unless the example specifically demonstrates it.

## Personal data

Never include real personal data in issues, pull requests, examples, logs or tests: no Aadhaar, PAN, phone numbers, personal emails, addresses, bank details or customer records. Use made-up values and reserved domains such as `example.com`. See [PRIVACY.md](PRIVACY.md).
