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

## 6. Upgrade and rollback

Use immutable image tags in real deployments (`RAGENT_IMAGE_TAG` can be a Git commit). Before an
upgrade, back up PostgreSQL and the two RustFS buckets. Build the new tag, start it, run smoke tests,
then switch the host proxy if needed. Rollback means restoring the prior image tag and configuration;
do not run `docker compose down -v`, because that removes optional Redis/RocketMQ volumes.

## 7. Public-demo cautions

- Rotate the server password and all provider keys that have ever appeared in source or chat.
- Replace the seeded administrator password before exposing the site.
- `APP_DEMO_MODE=true` currently blocks chat as well as writes, so leave it `false` for an interactive
  interview demo and protect administration separately.
- Apply request/token quotas to prevent model-cost abuse.
- Use Cloudflare Full (strict) TLS and keep its API token scoped to the single DNS zone.
