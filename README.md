# OS - Amazon Linux

```
sudo yum install -y yum-utils
```
```
sudo yum-config-manager --add-repo https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo
```
```
sudo yum -y install terraform
```
### Verify Installation
```
terraform -help
```

### Commands to Run terraform 
```
terraform init
```
```
terraform plan
```
```
terraform apply
```
#### This command will automatically apply your Terraform configuration changes without requiring any manual confirmation
```
terraform apply --auto-approve
```



