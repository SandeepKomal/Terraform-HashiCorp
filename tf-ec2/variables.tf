variable "aws_region" {
       description = "The AWS region to create Infrastructure" 
       default     = "us-east-1" 
}

variable "key_name" { 
    description = " SSH key to connect to ec2 instance" 
    default     =  "komaldockerp1" 
}

variable "instance_type" { 
    description = "instance type for ec2" 
    default     =  "t2.micro" 
}

variable "ami_id" { 
    description = "AMI for Amazon-Linux Ec2 instance" 
    default     = "ami-0230bd60aa48260c6" 
}

variable "subnet_id" { 
    description = "Subnet to launch Amazon-Linux Ec2 instance" 
    default     = "subnet-0684def2973a370da" 
}

variable "aws_security_group" { 
    description = "sg to launch Amazon-Linux Ec2 instance" 
    default     = "sg-0072f31d9ee310c5a" 
}
