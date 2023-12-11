provider "aws" {
  region = "us-east-1"  # Set your desired AWS region
}

resource "aws_db_instance" "example_rds" {
  identifier            = "example-db-instance"
  engine                = "mysql"
  instance_class        = "db.t2.micro"
  allocated_storage     = 20
  storage_type          = "gp2"
  engine_version        = "5.7.30"
  username              = "komal"
  password              = "komal@123"
  publicly_accessible  = true

  # Uncomment the following lines to use a specific subnet group and security group
  # db_subnet_group_name = aws_db_subnet_group.example.name
  # vpc_security_group_ids = [aws_security_group.example.id]

  tags = {
    Name = "komal-rds"
  }
}

# Uncomment the following block to create a subnet group and security group
# resource "aws_db_subnet_group" "example" {
#   name       = "example-subnet-group"
#   subnet_ids = aws_subnet.example[*].id
# }

# resource "aws_security_group" "example" {
#   name        = "example-security-group"
#   description = "Example security group for RDS"
#   ingress {
#     from_port   = 3306
#     to_port     = 3306
#     protocol    = "tcp"
#     cidr_blocks = ["0.0.0.0/0"]
#   }
# }
