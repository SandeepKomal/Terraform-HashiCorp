provider "aws" {
  region = var.aws_region
}

resource "aws_ecr_repository" "my_ecr_repo" {
  name                 = var.ecr_name
  image_tag_mutability = var.image_mutability
  force_delete         = false
  tags                 = var.tags

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = var.encrypt_type
  }
}

output "demo_app_repo_url" {
  value = aws_ecr_repository.my_ecr_repo.repository_url
}
