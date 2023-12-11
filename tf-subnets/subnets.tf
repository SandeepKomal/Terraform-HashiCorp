provider "aws" {
  region = "us-east-1" # Change this to your desired AWS region
}

resource "aws_vpc" "example" {
  cidr_block = "172.20.0.0/16"
}

resource "aws_subnet" "example_subnet" {
  vpc_id                  = aws_vpc.example.id
  cidr_block              = "172.20.0.0/24" # Change this to your desired CIDR block
  availability_zone       = "us-east-1a"  # Change this to your desired availability zone

  # Other optional parameters
  map_public_ip_on_launch = true
  tags = {
    Name = "komal Example Subnet"
  }
}




