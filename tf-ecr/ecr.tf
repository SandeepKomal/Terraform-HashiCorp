provider "aws" {
  region = "us-east-1"  # Set your desired AWS region
}

resource "aws_ecr_repository" "my_ecr_repo" {
  name = "psk-ecr-repo"
  image_tag_mutability = "MUTABLE"  # or "IMMUTABLE" depending on your requirements

  # Optional settings
  image_scanning_configuration {
    scan_on_push = false
  }

  # You can also configure lifecycle policies, encryption, etc.
}
