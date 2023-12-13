provider "aws" {
  region = "us-east-1"  # Adjust the region as needed
}

resource "aws_lb" "my_nlb" {
  name               = "my-nlb"
  internal           = false  # Set to true if the NLB should be internal
  load_balancer_type = "network"
  security_groups    = ["sg-02f0ea7e6c53031b3"]  # Replace with your security group ID(s)
  subnets            = ["subnet-0e197f08b5b755257", "subnet-046277c041194b849", "subnet-0684def2973a370da", "subnet-0c91eb495e92fc850", "subnet-04b7d58a379c261f2"]  # Replace with your subnet ID(s)

  enable_deletion_protection = false # Set to true if you want deletion protection
}

resource "aws_lb_listener" "my_listener" {
  load_balancer_arn = aws_lb.my_nlb.arn
  port              = 3360
  protocol          = "TCP"
  default_action {
    type = "forward"
    target_group_arn = aws_lb_target_group.my_target_group.arn
  }
}

resource "aws_lb_target_group" "my_target_group" {
  name        = "my-target-group"
  port        = 3360
  protocol    = "TCP"
  vpc_id      = "vpc-09b77ec6cfd8f4129"  # Replace with your VPC ID
  target_type = "instance"

  health_check {
    path = "/"
  }
}
