provider "aws" {
  region = var.region
}

resource "aws_db_instance" "aws_rds" {
  identifier                = var.db_instance_identifier
  allocated_storage         = var.allocated_storage
  storage_type              = var.storage_type
  engine                    = var.engine
  engine_version            = var.engine_version
  instance_class            = var.instance_class
  db_name                   = var.db_name
  username                  = var.db_username
  password                  = var.db_password
  storage_encrypted         = true
  publicly_accessible       = false
  vpc_security_group_ids    = var.vpc_security_group_ids
  multi_az                  = var.multi_az
  availability_zone         = var.availability_zone
  backup_retention_period   = var.backup_retention_period
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : var.final_snapshot_identifier

  tags = {
    Name        = "TCN-RDS"
    Environment = "Example"
    Owner       = "komal"
  }
}
