# BeamMP Server on AWS

Deploys a [BeamMP](https://beammp.com) multiplayer server for BeamNG.drive on an EC2 t3.micro in `sa-east-1` (São Paulo) using [SST v4](https://sst.dev).

## What gets provisioned

- EC2 t3.micro running Ubuntu 24.04
- BeamMP server running as a systemd service on port `30814`
- Elastic IP (stable address that survives stop/start)
- S3 bucket for mods (synced to the server on every service start)
- IAM role with SSM access (no SSH keys needed)

## Prerequisites

- [Node.js](https://nodejs.org)
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- [SSM plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for shelling into the instance

## Setup

1. Get a BeamMP auth key from [keymaster.beammp.com](https://keymaster.beammp.com) and fill it in `ServerConfig.toml`:

   ```toml
   AuthKey = "your-key-here"
   ```

2. Adjust any other settings in `ServerConfig.toml` as you like (name, max players, map, etc.).

## Deploy

```bash
npm install
npx sst deploy
```

The deploy outputs the instance ID, public IP, and mods bucket name. Players connect on port `30814`.

## Shell into the server

No SSH key needed — uses AWS SSM:

```bash
aws ssm start-session --target <instanceId> --region sa-east-1
```

Check server logs:

```bash
sudo journalctl -u beammp -f
```

## Test the port

```bash
nc -zv <ip> 30814
```

## Mods

Upload BeamMP mod `.zip` files to the mods bucket and restart the server to apply them:

```bash
# Upload a mod
aws s3 cp mymod.zip s3://<modsBucket>/

# Remove a mod
aws s3 rm s3://<modsBucket>/mymod.zip

# Restart the server to sync and apply
aws ssm start-session --target <instanceId> --region sa-east-1
sudo systemctl restart beammp
```

The server syncs the entire bucket to `Resources/Client` (with `--delete`) before each start, so removing a file from S3 removes it from the server on next restart.

## Change server settings

Edit `ServerConfig.toml` and redeploy. Or edit directly on the instance without redeploying:

```bash
sudo nano /opt/beammp/ServerConfig.toml
sudo systemctl restart beammp
```

## Tear down

```bash
npx sst remove
```
