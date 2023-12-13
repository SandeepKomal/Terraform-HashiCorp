provider "aws" {
  region = "us-east-1"  # Specify your desired AWS region
}

resource "aws_ebs_volume" "komalebs" {
  availability_zone = "us-east-1a"  # Specify the availability zone for the volume
  size             = 100            # Specify the size of the volume in gigabytes
  type             = "gp2"          # Specify the volume type (e.g., gp2, io1, st1, sc1)
  encrypted        = true           # Specify whether the volume should be encrypted

  tags = {
    Name = "komalEBSVolume"
    Environment = "Production"
  }
}

