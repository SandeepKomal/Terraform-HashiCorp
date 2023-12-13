provider "aws" {
  region = "us-east-1"  # Adjust the region as needed
}

resource "aws_lb" "my_alb2" {
  name               = "my-alb2"
  internal           = false  # Set to true if the ALB should be internal
  load_balancer_type = "application"
  security_groups    = ["sg-02f0ea7e6c53031b3"]  # Replace with your security group ID(s)
  subnets            = ["subnet-0e197f08b5b755257", "subnet-046277c041194b849","subnet-0684def2973a370da", "subnet-0c91eb495e92fc850","subnet-04b7d58a379c261f2"]  # Replace with your subnet ID(s)

  enable_deletion_protection = false # Set to true if you want deletion protection
}
resource "aws_lb_listener" "my_listener" {
  load_balancer_arn = aws_lb.my_alb2.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "OK"
      status_code  = "200"
    }
  }
}

resource "aws_lb_target_group" "my_target_group" {
  name        = "my-target-group"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = "vpc-09b77ec6cfd8f4129"  # Replace with your VPC ID
  target_type = "instance"

  health_check {
    path = "/"
  }
}

resource "aws_lb_listener_rule" "my_rule" {
  listener_arn = aws_lb_listener.my_listener.arn

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.my_target_group.arn
  }

  condition {
    path_pattern {
      values = ["/"]
   
  }
}
}
