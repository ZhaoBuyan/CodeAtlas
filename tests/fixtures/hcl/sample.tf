terraform {
  required_version = ">= 1.0"
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "deploy region"
}

locals {
  prefix = "app"
}

resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.micro"
  count         = 2
  tags = {
    Name = "${local.prefix}-web"
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

module "network" {
  source = "./modules/network"
  cidr   = "10.0.0.0/16"
}

output "ip" {
  value = aws_instance.web[0].public_ip
}
