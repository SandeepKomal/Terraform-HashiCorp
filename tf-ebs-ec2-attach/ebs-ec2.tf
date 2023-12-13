# Define the EBS volume
provider "aws" {
  region = "us-east-1"  # Specify your desired AWS region
}




resource "aws_ebs_volume" "sandyEBS" {
  availability_zone = "us-east-1d"
  size              = 100
  type             = "gp2"   
  encrypted        = true   
  tags = {
    Name = "sandyEBSVolume"
    Environment = "Production"
  }
}

# Define the EC2 instance
resource "aws_instance" "sandy_instance" {
  ami           = "ami-0230bd60aa48260c6"
  instance_type = "t2.micro"
  availability_zone = "us-east-1d"
   tags = {
    Name = "sandyEc2"
    
  }




}

# Attach the EBS volume to the EC2 instance
resource "aws_volume_attachment" "example_attachment" {
  device_name = "/dev/xvda"
  volume_id   = aws_ebs_volume.sandyEBS.id
  instance_id = aws_instance.sandy_instance.id
}