variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "db_instance_identifier" {
  description = "RDS instance identifier"
  type        = string
  default     = "database-tcn"
}

variable "allocated_storage" {
  description = "Allocated storage in GB"
  type        = number
  default     = 20
}

variable "storage_type" {
  description = "RDS storage type"
  type        = string
  default     = "gp3"
}

variable "engine" {
  description = "Database engine"
  type        = string
  default     = "mysql"
}

variable "engine_version" {
  description = "Database engine version supported by the selected AWS region"
  type        = string
  default     = "8.0"
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "db_name" {
  description = "Initial database name"
  type        = string
  default     = "tcn"
}

variable "db_username" {
  description = "Database username"
  type        = string
  default     = "tcn"
}

variable "db_password" {
  description = "Database password supplied through a secure variable mechanism"
  type        = string
  sensitive   = true
}

variable "vpc_security_group_ids" {
  description = "Security groups associated with the RDS instance"
  type        = list(string)
}

variable "availability_zone" {
  description = "Optional AZ for single-AZ RDS"
  type        = string
  default     = null
  nullable    = true
}

variable "multi_az" {
  description = "Whether to deploy RDS Multi-AZ"
  type        = bool
  default     = false
}

variable "backup_retention_period" {
  description = "Automated backup retention in days"
  type        = number
  default     = 7
}

variable "skip_final_snapshot" {
  description = "Whether to skip the final snapshot on deletion"
  type        = bool
  default     = true
}

variable "final_snapshot_identifier" {
  description = "Final snapshot identifier when skip_final_snapshot is false"
  type        = string
  default     = "tcn-final-snapshot"
}
