resource "aws_eip" "eip_for_nat_gateway_1" {
  domain = "vpc"

  tags = {
    Name = "EIP 1"
  }
}

resource "aws_eip" "eip_for_nat_gateway_2" {
  domain = "vpc"

  tags = {
    Name = "EIP 2"
  }
}

resource "aws_nat_gateway" "nat_gateway_1" {
  allocation_id = aws_eip.eip_for_nat_gateway_1.id
  subnet_id     = aws_subnet.public-subnet-1.id

  tags = {
    Name = "NAT Gateway Public Subnet 1"
  }
}

resource "aws_nat_gateway" "nat_gateway_2" {
  allocation_id = aws_eip.eip_for_nat_gateway_2.id
  subnet_id     = aws_subnet.public-subnet-2.id

  tags = {
    Name = "NAT Gateway Public Subnet 2"
  }
}

resource "aws_route_table" "private_route_table_1" {
  vpc_id = aws_vpc.vpc.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat_gateway_1.id
  }

  tags = {
    Name = "Private Route Table 1"
  }
}

resource "aws_route_table_association" "private_subnet_1" {
  subnet_id      = aws_subnet.private-subnet-1.id
  route_table_id = aws_route_table.private_route_table_1.id
}

resource "aws_route_table_association" "private_subnet_3" {
  subnet_id      = aws_subnet.private-subnet-3.id
  route_table_id = aws_route_table.private_route_table_1.id
}

resource "aws_route_table" "private_route_table_2" {
  vpc_id = aws_vpc.vpc.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat_gateway_2.id
  }

  tags = {
    Name = "Private Route Table 2"
  }
}

resource "aws_route_table_association" "private_subnet_2" {
  subnet_id      = aws_subnet.private-subnet-2.id
  route_table_id = aws_route_table.private_route_table_2.id
}

resource "aws_route_table_association" "private_subnet_4" {
  subnet_id      = aws_subnet.private-subnet-4.id
  route_table_id = aws_route_table.private_route_table_2.id
}
