variable "aws_region" {
  description = "Aws Region"
  type        = string
}

variable "ecr_name" {
  description = "The list of ecr names to create"
  type        = string
}
variable "tags" {
  description = "The key-value maps for tagging"
  type        = map(string)

}


variable "encrypt_type" {
  description = "Provide type of encryption here"
  type        = string
  default     = "KMS"
}

variable "image_mutability" {
  description = "IMMUTABLE keeps each tag pointing at one image, so deployments are repeatable"
  type        = string
  default     = "IMMUTABLE"

  validation {
    condition     = contains(["IMMUTABLE", "MUTABLE"], var.image_mutability)
    error_message = "image_mutability must be IMMUTABLE or MUTABLE."
  }
}