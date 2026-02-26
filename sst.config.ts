/// <reference path=".sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "beammp",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "sa-east-1" },
      },
    };
  },
  async run() {
    const { readFileSync } = await import("node:fs");
    const serverConfig = readFileSync("ServerConfig.toml", "utf-8");

    // Security group — only BeamMP port needed (SSM replaces SSH)
    const sg = new aws.ec2.SecurityGroup("BeamMPSG", {
      description: "BeamMP server",
      ingress: [
        {
          description: "BeamMP TCP",
          protocol: "tcp",
          fromPort: 30814,
          toPort: 30814,
          cidrBlocks: ["0.0.0.0/0"],
        },
        {
          description: "BeamMP UDP",
          protocol: "udp",
          fromPort: 30814,
          toPort: 30814,
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
      egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
      ],
    });

    // IAM role — AmazonSSMManagedInstanceCore lets you shell in via SSM
    // without opening port 22 or managing SSH keys
    const role = new aws.iam.Role("BeamMPRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
          },
        ],
      }),
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      ],
    });

    const profile = new aws.iam.InstanceProfile("BeamMPProfile", {
      role: role.name,
    });

    // S3 bucket for mods — upload .zip files here, then restart the server
    const modsBucket = new sst.aws.Bucket("BeamMPMods");
    new aws.iam.RolePolicy("BeamMPModsPolicy", {
      role: role.name,
      policy: modsBucket.arn.apply((arn: string) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:ListBucket"],
              Resource: [arn, `${arn}/*`],
            },
          ],
        }),
      ),
    });

    // Latest Ubuntu 24.04 LTS x86_64 AMI (Canonical)
    const ami = aws.ec2.getAmiOutput({
      mostRecent: true,
      owners: ["099720109477"],
      filters: [
        {
          name: "name",
          values: [
            "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
          ],
        },
        { name: "state", values: ["available"] },
      ],
    });

    // Elastic IP so the server address never changes between stop/starts
    const eip = new aws.ec2.Eip("BeamMPEip", { domain: "vpc" });

    // Inject the auth key and bucket name at deploy time; EC2 runs this script on first boot
    const userData = $interpolate`#!/bin/bash
set -euxo pipefail

apt-get update -y
apt-get install -y curl liblua5.3-0 unzip
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

mkdir -p /opt/beammp/Resources/Server /opt/beammp/Resources/Client

# Create a non-login system user to run the server
id -u beammp &>/dev/null || useradd -r -s /sbin/nologin -d /opt/beammp beammp

# Download latest BeamMP server binary (Ubuntu 24.04 build)
RELEASE=$(curl -sf https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest \
  | grep '"tag_name"' | cut -d'"' -f4)
curl -fL -o /opt/beammp/BeamMP-Server \
  "https://github.com/BeamMP/BeamMP-Server/releases/download/$RELEASE/BeamMP-Server.ubuntu.24.04.x86_64"
chmod +x /opt/beammp/BeamMP-Server

# Server config — edit ServerConfig.toml in the repo and redeploy
cat > /opt/beammp/ServerConfig.toml << 'TOML'
${serverConfig}TOML

chown -R beammp:beammp /opt/beammp

# Systemd service — syncs mods from S3 on every start/restart
cat > /etc/systemd/system/beammp.service << 'UNIT'
[Unit]
Description=BeamMP Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=beammp
WorkingDirectory=/opt/beammp
ExecStartPre=/usr/local/bin/aws s3 sync s3://${modsBucket.name}/ /opt/beammp/Resources/Client --delete
ExecStart=/opt/beammp/BeamMP-Server
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now beammp
`;

    const instance = new aws.ec2.Instance("BeamMPServer", {
      instanceType: "t3.micro",
      ami: ami.id,
      iamInstanceProfile: profile.name,
      associatePublicIpAddress: true,
      vpcSecurityGroupIds: [sg.id],
      userData,
      // Replacing user data (e.g. after sst secret set) recreates the instance
      userDataReplaceOnChange: true,
      rootBlockDevice: {
        volumeType: "gp3",
        volumeSize: 30,
      },
      tags: { Name: "beammp-server" },
    });

    new aws.ec2.EipAssociation("BeamMPEipAssoc", {
      instanceId: instance.id,
      allocationId: eip.allocationId,
    });

    return {
      ip: eip.publicIp,
      instanceId: instance.id,
      modsBucket: modsBucket.name,
    };
  },
});
