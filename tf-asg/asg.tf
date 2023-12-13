provider "aws" {
  region = "us-east-1"
}

resource "aws_launch_configuration" "example" {
  name = "example_config"
  image_id = "ami-0230bd60aa48260c6"  # Specify your AMI ID
  instance_type = "t2.micro" # Specify your instance type

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "example" {
  desired_capacity     = 2
  max_size             = 5
  min_size             = 1
  vpc_zone_identifier  = ["subnet-0e197f08b5b755257", "subnet-046277c041194b849", "subnet-0684def2973a370da", "subnet-0c91eb495e92fc850", "subnet-04b7d58a379c261f2"] # Specify your subnet ID(s)
  launch_configuration = aws_launch_configuration.example.id
}
