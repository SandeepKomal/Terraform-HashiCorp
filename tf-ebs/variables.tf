variable "aws_region" {
  description = "AWS region where resources are provisioned"
  type        = string
}

variable "aws_profile" {
  description = "Optional AWS profile used by your local CLI"
  type        = string
  default     = null
  nullable    = true
}

variable "ebs_availability_zone" {
  description = "Availability zone for the EBS volume"
  type        = string
}

variable "ebs_size" {
  description = "EBS volume size in GB"
  type        = number
}

variable "ebs_type" {
  description = "EBS volume type"
  type        = string
  default     = "gp3"
}

variable "ebs_encrypted" {
  description = "Whether the EBS volume is encrypted"
  type        = bool
  default     = true
}

variable "ebs_name" {
  description = "Name tag for the EBS volume"
  type        = string
}

variable "ebs_environment" {
  description = "Environment tag"
  type        = string
  default     = "dev"
}

variable "instance_id" {
  description = "EC2 instance ID to attach the volume to"
  type        = string
}

variable "device_name" {
  description = "Non-root device name to attach to the instance"
  type        = string
  default     = "/dev/sdf"
}
