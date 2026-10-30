provider "aws" {
  region = var.aws_region
}

# Create security group with firewall rules
resource "aws_instance" "myFirstInstance" {
  subnet_id              = var.subnet_id
  ami                    = var.ami_id
  key_name               = var.key_name
  instance_type          = var.instance_type
  vpc_security_group_ids = [var.aws_security_group]

  # IMDSv2 only, and an encrypted root disk.
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    encrypted = true
  }

  tags = {
    Name = "komaltf1 Instance"
  }
}
