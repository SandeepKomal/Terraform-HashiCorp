provider "aws" {
  region = "us-east-1"  # Change this to your desired AWS region
}

resource "aws_efs_file_system" "example" {
  creation_token = "my-efs"
  performance_mode = "generalPurpose"

  lifecycle_policy {
    transition_to_ia = "AFTER_7_DAYS"
  }
}
