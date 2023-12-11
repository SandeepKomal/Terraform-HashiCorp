provider "aws" {
  region = var.aws_region
}

#Create security group with firewall rules


resource "aws_instance" "myFirstInstance" {
  subnet_id = var.subnet_id
  ami     = var.ami_id
  key_name = var.key_name
  instance_type = var.instance_type
  vpc_security_group_ids = [ var.aws_security_group ]
  tags= {
    Name = "komaltf1 Instance"
  }
}  
