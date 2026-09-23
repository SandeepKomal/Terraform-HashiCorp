variable "vpc_id" {
  description = "VPC ID where the security group will be created"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "ssh_cidr_block" {
  description = "Trusted CIDR blocks allowed to access SSH. Never use 0.0.0.0/0."
  type        = list(string)

  validation {
    condition     = alltrue([for cidr in var.ssh_cidr_block : cidr != "0.0.0.0/0"])
    error_message = "Do not expose SSH to the entire internet."
  }
}

variable "https_cidr_block" {
  description = "CIDR blocks allowed to access HTTPS"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
