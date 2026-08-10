# Ragent cloud deployment

This deployment packages the Ragent backend, MCP server, and frontend gateway. It reuses the
PostgreSQL/pgvector, RustFS, and RocketMQ containers already running on the cloud server. The
optional `compose.infra.yaml` overlay starts only Redis, which is not currently installed there.

## 1. Server prerequisites

- Linux x86_64/arm64 with Docker Engine and Docker Compose v2
- Existing PostgreSQL with the `vector` extension and the Ragent schema
- Existing RustFS with credentials that may create/read/write the configured buckets
- At least 4 GB RAM for a small demo; 8 GB is strongly preferred for sustained use
- Only ports 80/443 should be public. Database, RustFS, Redis, RocketMQ, backend, and MCP stay internal

The Redis overlay requires memory overcommit on the Docker host. Configure it persistently before
starting Redis so background persistence cannot fail under memory pressure:

```bash
printf '%s\n' 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-ragent-redis.conf >/dev/null
sudo sysctl -p /etc/sysctl.d/99-ragent-redis.conf
```

The schema scripts are not run automatically. Never rerun `resources/database/schema_pg.sql` against
an existing database without first checking the schema and taking a backup.

### GHCR pull needs a local proxy (mihomo)

This host is in mainland China; Docker Hub and ghcr.io pulls are slow or stall when connecting
directly. The host runs mihomo (Clash Meta) as a local mixed proxy on `127.0.0.1:7891`. Configure
the Docker daemon to use it so image pulls work:

```bash
cat > /etc/systemd/system/docker.service.d/proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:7891"
Environment="HTTPS_PROXY=http://127.0.0.1:7891"
Environment="NO_PROXY=localhost,127.0.0.1,*.local,.internal"
EOF
systemctl daemon-reload && systemctl restart docker

# keep the proxy alive across reboots
systemctl enable --now mihomo
```

The old `~/.docker/config.json` proxies entry (host.docker.internal:7891) is a Docker Desktop
artifact and is unreachable on Linux; it only affects `docker build`/`run` network, not daemon pulls,
and should be removed. Container runtime networking stays direct thanks to the compose-level
`x-direct-network-environment` anchor, so application traffic never goes through the proxy.
## 2. Join the existing infrastructure

Create one internal network for PostgreSQL, RustFS, and the managed Redis:

```bash
docker network create ragent-infra
docker network connect --alias postgres ragent-infra <postgres-container>
docker network connect --alias rustfs ragent-infra <rustfs-container>
```

Set `ROCKETMQ_NETWORK` to the existing RocketMQ network. The backend joins that network directly so
the broker address returned by the name server remains reachable. Do not expose PostgreSQL,
RustFS, Redis, RocketMQ, the backend, or MCP publicly just to make the application connect.

## 3. Configure

```bash
cd deploy/cloud
cp .env.example .env
chmod 600 .env
```

Replace every `CHANGE_ME`, set the real HTTPS origin, and use dedicated bucket names. The cloud
profile requires Bailian and SiliconFlow keys. MinerU and You.com keys are optional unless their
features are enabled.

On a small server, build and test the artifacts on the development machine first, upload only the
two JARs plus `frontend/dist`, and select the runtime-only Dockerfiles:

```dotenv
RAGENT_JAVA_DOCKERFILE=deploy/cloud/Dockerfile.runtime
RAGENT_FRONTEND_DOCKERFILE=deploy/cloud/frontend.runtime.Dockerfile
```

The regular Dockerfiles remain available for hosts with enough disk/RAM to perform Maven and npm
builds inside Docker.

The application uses `RUSTFS_ENDPOINT` for internal signed/API traffic and `RUSTFS_PUBLIC_URL` for
browser-visible assets. For the included gateway, use:

```dotenv
RUSTFS_ENDPOINT=http://rustfs:9000
RUSTFS_PUBLIC_URL=https://rag.example.com/storage
```

## 4. Validate and start

When Redis already exists:

```bash
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml up -d --build
```

When Redis does not exist, add the Redis-only overlay:

```bash
docker compose --env-file .env -f compose.yaml -f compose.infra.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.infra.yaml up -d --build
```

Check status and logs:

```bash
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs -f --tail=200 backend mcp-server web
curl -fsS http://127.0.0.1:19080/healthz
```

The gateway intentionally binds to `127.0.0.1:19080`. Put the existing host Nginx/Caddy in front of
it. `nginx-host.conf.example` shows the required upload and SSE proxy settings.

Keep `logback-cloud.xml` next to `compose.yaml`. The backend mounts it read-only to suppress one
known benign Spring lifecycle diagnostic while retaining all other warnings. Compose also places
RocketMQ's private rolling log under writable `/tmp`; its console output remains covered by the
Docker log rotation policy.

## 5. PostgreSQL checks

Run these read-only checks before the first application start:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
SELECT to_regclass('public.t_user');
SELECT to_regclass('public.t_knowledge_vector');
SELECT vector_dims(embedding) FROM t_knowledge_vector WHERE embedding IS NOT NULL LIMIT 1;
```

The configured embedding dimension is 1536. Existing vectors with another dimension require a
planned reindex; do not alter the column or discard vectors during deployment.

## 6. CI/CD (GitHub Actions → GHCR → cloud host)

After the first manual bring-up, day-to-day releases are automated:

```text
git push origin main
  → GitHub Actions builds backend / mcp-server / web images
  → pushes to ghcr.io/allurecurtain/ragent-*
  → SSH to the cloud host, pull images, compose up -d
```

### 6.1 One-time GitHub Secrets

Repository → Settings → Secrets and variables → Actions:

| Secret | Example | Purpose |
| --- | --- | --- |
| `DEPLOY_HOST` | `82.156.116.18` | Cloud server IP/DNS |
| `DEPLOY_USER` | `root` | SSH user |
| `DEPLOY_SSH_KEY` | ed25519 private key | Deploy key (password auth is not used) |
| `DEPLOY_PORT` | `22` | Optional, defaults to 22 |

Image pull during deploy reuses `GITHUB_TOKEN` (packages:write). No extra GHCR token is required.

Install the matching public key into the server `~/.ssh/authorized_keys` once.

### 6.2 Image coordinates

CI writes these into the host `.env` on every rollout:

```dotenv
RAGENT_IMAGE_TAG=<git-sha7>
RAGENT_BACKEND_IMAGE=ghcr.io/allurecurtain/ragent-backend
RAGENT_MCP_IMAGE=ghcr.io/allurecurtain/ragent-mcp-server
RAGENT_WEB_IMAGE=ghcr.io/allurecurtain/ragent-web
```

Host path is fixed at `/opt/ragent/deploy/cloud`. Secrets and model keys stay only in that host `.env`.

### 6.3 Manual / skip-deploy runs

- Actions → **Deploy Cloud** → Run workflow
- Set `skip_deploy=true` to only build/push images

Remote entrypoint: `deploy/cloud/scripts/remote-rollout.sh`.

### 6.4 Upgrade and rollback

Use immutable image tags in real deployments (`RAGENT_IMAGE_TAG` is a Git short SHA). Before an
upgrade that includes schema changes, apply `resources/database/upgrades/...` SQL and back up
PostgreSQL plus the two RustFS buckets. Rollback means restoring the prior image tag in `.env` and
`docker compose up -d --no-build`; do not run `docker compose down -v`, because that removes optional
Redis volumes.

## 7. Public-demo cautions

- Rotate the server password and all provider keys that have ever appeared in source or chat.
- Replace the seeded administrator password before exposing the site.
- `APP_DEMO_MODE=true` currently blocks chat as well as writes, so leave it `false` for an interactive
  interview demo and protect administration separately.
- Apply request/token quotas to prevent model-cost abuse.
- Use Cloudflare Full (strict) TLS and keep its API token scoped to the single DNS zone.
