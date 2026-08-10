#!/usr/bin/env bash
# Remote rollout for Ragent cloud host.
# Expected env:
#   IMAGE_TAG, BACKEND_IMAGE, MCP_IMAGE, WEB_IMAGE
#   GHCR_USER, GHCR_TOKEN   (for private GHCR pulls)
# Optional:
#   DEPLOY_DIR  (default /opt/ragent/deploy/cloud)
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/ragent/deploy/cloud}"
cd "$DEPLOY_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: missing ${DEPLOY_DIR}/.env" >&2
  exit 1
fi

: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${BACKEND_IMAGE:?BACKEND_IMAGE is required}"
: "${MCP_IMAGE:?MCP_IMAGE is required}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"

# The host's ~/.docker/config.json may carry a desktop-only proxy (host.docker.internal:7891)
# that is unreachable on this Linux host and hangs every docker pull/login. Strip it defensively.
if [ -f "$HOME/.docker/config.json" ] && python3 - <<'PY' 2>/dev/null; then
import json, os, sys
p = os.path.expanduser('~/.docker/config.json')
d = json.load(open(p))
if 'proxies' in d:
    del d['proxies']
    json.dump(d, open(p, 'w'), indent=2)
    sys.exit(0)  # changed
sys.exit(1)  # no change
PY
echo '==> removed unreachable docker proxy from ~/.docker/config.json'
fi

echo "==> Rolling out tag=${IMAGE_TAG}"
echo "    backend=${BACKEND_IMAGE}:${IMAGE_TAG}"
echo "    mcp=${MCP_IMAGE}:${IMAGE_TAG}"
echo "    web=${WEB_IMAGE}:${IMAGE_TAG}"

# Backup .env before mutating image coordinates.
ts="$(date +%Y%m%d-%H%M%S)"
cp -a .env ".env.bak-rollout-${ts}"

upsert_env() {
  local key="$1"
  local value="$2"
  local file=".env"
  if grep -qE "^${key}=" "$file"; then
    # portable-ish in-place replace without breaking other lines
    awk -v k="$key" -v v="$value" '
      BEGIN { done=0 }
      $0 ~ "^" k "=" {
        print k "=" v
        done=1
        next
      }
      { print }
      END {
        if (!done) print k "=" v
      }
    ' "$file" > "${file}.tmp"
    mv "${file}.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

upsert_env RAGENT_IMAGE_TAG "$IMAGE_TAG"
upsert_env RAGENT_BACKEND_IMAGE "$BACKEND_IMAGE"
upsert_env RAGENT_MCP_IMAGE "$MCP_IMAGE"
upsert_env RAGENT_WEB_IMAGE "$WEB_IMAGE"
# CI ships prebuilt images; keep runtime dockerfiles as no-op markers for local rebuilds.
upsert_env RAGENT_JAVA_DOCKERFILE "deploy/cloud/Dockerfile.runtime"
upsert_env RAGENT_FRONTEND_DOCKERFILE "deploy/cloud/frontend.runtime.Dockerfile"

chmod 600 .env

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "==> docker login ghcr.io"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-allurecurtain}" --password-stdin
else
  echo "WARN: GHCR_TOKEN empty; pull will only work for public packages" >&2
fi

compose() {
  docker compose --env-file .env -f compose.yaml -f compose.infra.yaml "$@"
}

echo "==> compose config check"
compose config --quiet

# Pull one service at a time to reduce peak disk/memory pressure on 4G hosts.
for svc in mcp-server backend web; do
  echo "==> pull ${svc}"
  compose pull "$svc"
done

echo "==> up -d (no build)"
compose up -d --no-build --remove-orphans mcp-server backend web redis

echo "==> wait for health"
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  if curl -fsS "http://127.0.0.1:19080/healthz" >/dev/null 2>&1; then
    echo "gateway healthz OK"
    break
  fi
  sleep 5
done

if ! curl -fsS "http://127.0.0.1:19080/healthz" >/dev/null 2>&1; then
  echo "ERROR: gateway healthz failed" >&2
  compose ps
  compose logs --tail=80 backend mcp-server web || true
  exit 1
fi

echo "==> service status"
compose ps

# Best-effort cleanup of dangling layers only (never remove volumes).
docker image prune -f >/dev/null 2>&1 || true

echo "==> rollout complete: ${IMAGE_TAG}"
