# NexusQA 云端版本发布流程

本文档用于将公开仓库的最新代码、本地业务修改和 NexusQA 品牌定制，安全地发布到云服务器上的 Docker 环境。

本文档描述的是版本升级流程。首次部署、网络和基础设施配置参见 [README.md](./README.md)。

## 1. 基本原则

- `upstream` 是公开仓库，只用于拉取代码，禁止推送。
- `origin` 是私有仓库，用于保存 NexusQA 定制和发布分支。
- 生产环境必须对应一个确定的 Git Commit SHA，Docker 镜像使用该 SHA 作为不可变标签。
- 上游代码先进入 `main`，再合并到 NexusQA 云端分支。不要直接用 `main` 覆盖生产版本。
- Maven、npm、测试和生产产物构建都在本地完成。云服务器只封装运行时镜像。
- 发布前必须备份 PostgreSQL、RustFS 和部署配置。
- 数据库只执行本次尚未应用的增量迁移，禁止在已有数据库上重新执行初始化脚本。
- 不覆盖服务器上的 `.env`，不在日志或命令输出中展示密钥。
- 禁止执行 `docker compose down -v`。

## 2. 当前部署约定

| 项目 | 约定 |
| --- | --- |
| 公网地址 | `https://rag.785777.xyz` |
| 服务器发布根目录 | `/opt/ragent` |
| Compose 目录 | `/opt/ragent/deploy/cloud` |
| 版本暂存目录 | `/opt/ragent/releases/<commit-sha>` |
| 备份目录 | `/opt/ragent/backups/<commit-sha>-predeploy` |
| PostgreSQL 容器 | `shared-postgres` |
| RustFS 容器 | `rustfs` |
| Compose 项目名 | `ragent-cloud` |
| 本机网关端口 | `127.0.0.1:19080` |

不要依赖本文档中的历史版本号判断线上版本。每次操作前以服务器 `.env` 和运行中容器为准：

```bash
cd /opt/ragent/deploy/cloud
grep '^RAGENT_IMAGE_TAG=' .env
docker compose --env-file .env -f compose.yaml -f compose.infra.yaml ps
docker compose --env-file .env -f compose.yaml -f compose.infra.yaml images
```

## 3. 分支模型

推荐维护以下分支：

```text
upstream/main
    |
    v
main                         同步公开上游
    |
    v
cloud/nexusqa                长期保存 NexusQA 品牌和云端适配
    |
    v
release/cloud-YYYYMMDD-name  单次发布冻结和修复
    |
    v
Docker images:<commit-sha>   生产运行版本
```

长期云端分支只需初始化一次。当前没有 `cloud/nexusqa` 时，可以从最近一次已验证的云端发布分支创建：

```powershell
git switch <last-verified-cloud-release-branch>
git switch -c cloud/nexusqa
git push --set-upstream origin cloud/nexusqa
```

后续业务修改建议先进入功能分支，再合并到 `cloud/nexusqa`。每次正式发布可以从 `cloud/nexusqa` 创建新的日期发布分支。

## 4. 发布前准备

### 4.1 确认工作区

```powershell
git status --short
git remote -v
```

合并上游或制作发布产物前，工作区必须干净。不要把日志、评测结果、临时文件或其他未完成修改混入发布提交。

当主工作区存在其他工作时，使用独立 Git worktree：

```powershell
git worktree add ..\ragent-release-<date> <release-branch>
```

### 4.2 同步公开上游

```powershell
git fetch upstream
git fetch origin
git switch main
git merge --ff-only upstream/main
git push origin main
```

如果 `--ff-only` 失败，说明本地 `main` 与上游已经分叉。先查看历史并确定原因，不要通过强制重置或强推掩盖分叉：

```powershell
git log --graph --oneline --decorate --all -30
```

### 4.3 合并到 NexusQA 云端分支

```powershell
git switch cloud/nexusqa
git merge main
```

出现冲突时逐文件解决。不要对整个仓库统一选择 `ours` 或 `theirs`。特别检查以下内容：

- `frontend/index.html`
- `frontend/public/favicon.svg`
- `frontend/src/components/layout/Sidebar.tsx`
- `frontend/src/pages/admin/AdminLayout.tsx`
- 登录页默认输入值
- `bootstrap/src/main/resources/application-cloud.yaml`
- `deploy/cloud`
- 云端模型、Embedding 和存储适配

解决冲突后检查：

```powershell
git diff --name-only --diff-filter=U
git status --short
```

### 4.4 创建本次发布分支

```powershell
$ReleaseDate = Get-Date -Format yyyyMMdd
git switch -c "release/cloud-$ReleaseDate-<short-name>"
```

在该分支完成冲突修复、版本兼容修改和发布验证，不要继续向已部署的旧发布分支追加业务改动。

## 5. 品牌和变更审计

### 5.1 NexusQA 品牌检查

```powershell
rg -n "NexusQA" frontend/src frontend/index.html frontend/public
rg -n -i "ragent" frontend/src frontend/index.html frontend/public
```

应确认以下可见内容仍为 NexusQA：

- 浏览器标题：`NexusQA 智能问答`
- 聊天侧栏：`NexusQA`、`智能问答平台`
- 管理后台：`NexusQA 管理后台`
- 审计页面和 favicon
- 登录页不预填生产密码

以下技术标识通常不需要改名：

- Java 包名 `com.nageoffer.ai.ragent`
- 后端路径 `/api/ragent`
- Docker Compose 项目名和容器名
- localStorage 兼容键，例如 `ragent_token`
- 数据库名和历史表结构

搜索结果必须人工判断，不要做全仓库机械替换。

### 5.2 检查本次差异

先从服务器查询当前生产 SHA，再检查从旧版本到候选版本的完整差异：

```powershell
git diff --stat <previous-production-sha>..HEAD
git diff --name-status <previous-production-sha>..HEAD
git log --oneline <previous-production-sha>..HEAD
```

重点检查数据库升级文件：

```powershell
git diff --name-only <previous-production-sha>..HEAD -- resources/database/upgrades
```

对于每条迁移，发布前必须回答：

1. 线上是否已经执行过？
2. 是否可以在旧应用仍运行时提前执行？
3. 是否只新增字段或表，还是存在删除、重命名、回填等破坏性操作？
4. 应用回滚后旧版本能否继续使用新结构？
5. 是否需要单独的数据回滚方案？

禁止在已有数据库上执行 `resources/database/schema_pg.sql`、`schema_table.sql` 或其他初始化脚本。

## 6. 本地验证和打包

以下命令在干净发布 worktree 中执行。

### 6.1 后端测试

```powershell
.\mvnw.cmd test
```

如果完整测试依赖本机未启动的 PostgreSQL、Redis、RustFS、RocketMQ 或外部模型，应记录环境性失败，并至少运行与本次变更相关的定向单元测试。不能用 `-DskipTests` 代替测试。

### 6.2 前端验证

```powershell
cd frontend
npm ci
npm run lint
npm run build
cd ..
```

如果上游已有 lint 基线问题，应记录现有数量，并确认本次修改没有新增问题。生产构建必须成功。

构建完成后再次检查真实产物：

```powershell
rg -a -l "NexusQA" frontend/dist
Get-Content -Raw frontend/dist/index.html
```

### 6.3 生产 JAR

测试通过后再制作生产 JAR：

```powershell
.\mvnw.cmd clean package "-DskipTests"
```

确认产物存在：

```powershell
Get-Item bootstrap/target/bootstrap-*.jar
Get-Item mcp-server/target/mcp-server-*.jar
```

根据本次改动检查关键类和配置确实进入 JAR。例如：

```powershell
jar tf bootstrap/target/bootstrap-0.0.1-SNAPSHOT.jar |
  Select-String "BOOT-INF/classes/application-cloud.yaml|BOOT-INF/lib/infra-ai"
```

### 6.4 保存本地产物哈希

```powershell
Get-FileHash -Algorithm SHA256 `
  bootstrap/target/bootstrap-0.0.1-SNAPSHOT.jar, `
  mcp-server/target/mcp-server-0.0.1-SNAPSHOT.jar
```

上传后必须与服务器哈希逐项比较。

## 7. 提交到私有仓库

只暂存本次发布文件：

```powershell
git add -- <explicit-file-list>
git diff --cached --check
git diff --cached --stat
git commit -m "<release-related-message>"
git push --set-upstream origin <release-branch>
```

禁止向 `upstream` 推送。记录完整和短 SHA：

```powershell
$ReleaseSha = git rev-parse HEAD
$ReleaseTag = git rev-parse --short=7 HEAD
$ReleaseSha
$ReleaseTag
```

后续服务器目录使用完整或短 SHA，Docker 镜像标签至少使用 7 位短 SHA。不得使用可变的 `latest` 作为生产版本。

## 8. 生产只读检查

在任何修改之前执行：

```bash
cd /opt/ragent/deploy/cloud

grep '^RAGENT_IMAGE_TAG=' .env
docker compose --env-file .env -f compose.yaml -f compose.infra.yaml ps
docker compose --env-file .env -f compose.yaml -f compose.infra.yaml images
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
df -h / /opt/ragent
free -h
```

进入下一步前应满足：

- 当前容器健康，没有重启循环。
- 已记录旧 `RAGENT_IMAGE_TAG`。
- 旧版本镜像仍在服务器上。
- 磁盘足以同时容纳备份、新产物和新镜像。
- 没有正在执行的文档摄取、索引重建或其他重要写任务。

这台服务器资源较紧张，不要在服务器执行 Maven 或 npm 构建。

## 9. 发布前备份

下面示例备份整个 Ragent 数据库、RustFS 数据目录和部署配置。替换 `<release-tag>` 后执行。

```bash
set -euo pipefail
umask 077

release_tag=<release-tag>
backup_dir=/opt/ragent/backups/${release_tag}-predeploy

test ! -e "$backup_dir"
install -d -m 700 "$backup_dir"

docker exec shared-postgres \
  pg_dump -U postgres -d ragent --format=custom --no-owner --no-acl \
  > "$backup_dir/ragent.dump"

docker exec shared-postgres \
  pg_dumpall -U postgres --globals-only \
  > "$backup_dir/postgres-globals.sql"

docker exec -i shared-postgres \
  pg_restore --list < "$backup_dir/ragent.dump" > /dev/null

rustfs_paused=0
cleanup() {
  if [ "$rustfs_paused" -eq 1 ]; then
    docker unpause rustfs > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker pause rustfs > /dev/null
rustfs_paused=1
tar --numeric-owner -C /opt/rustfs \
  -czf "$backup_dir/rustfs-data.tar.gz" data
docker unpause rustfs > /dev/null
rustfs_paused=0
trap - EXIT

tar -tzf "$backup_dir/rustfs-data.tar.gz" > /dev/null

tar -C /opt/ragent -czf "$backup_dir/deploy-config.tar.gz" \
  deploy/cloud/.env \
  deploy/cloud/compose.yaml \
  deploy/cloud/compose.infra.yaml \
  deploy/cloud/logback-cloud.xml \
  deploy/cloud/nginx/default.conf.template

sha256sum \
  "$backup_dir/ragent.dump" \
  "$backup_dir/postgres-globals.sql" \
  "$backup_dir/rustfs-data.tar.gz" \
  "$backup_dir/deploy-config.tar.gz" \
  > "$backup_dir/SHA256SUMS"

chmod 600 "$backup_dir"/*
sha256sum -c "$backup_dir/SHA256SUMS"
```

备份目录包含数据库和 `.env`，权限必须保持为 `0700`，其中的文件保持为 `0600`。不要下载到不受保护的位置或提交到 Git。

备份完成后确认 RustFS 已解除暂停：

```bash
docker inspect -f '{{.State.Status}} {{.State.Paused}}' rustfs
curl -fsS http://127.0.0.1:19080/healthz
```

## 10. 数据库迁移

### 10.1 先做只读核验

使用 `information_schema.columns`、`to_regclass` 或业务查询确认目标结构是否存在。不要仅根据文件名猜测迁移状态。

```bash
docker exec shared-postgres psql \
  -X -v ON_ERROR_STOP=1 -U postgres -d ragent \
  -c "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position;"
```

### 10.2 上传并校验迁移文件

```bash
install -d -m 755 /opt/ragent/releases/<release-tag>/migrations
```

从本地上传本次需要的迁移文件后，分别计算本地和服务器 SHA256。内容不一致时禁止执行。

### 10.3 在单个事务中执行

按确定顺序显式列出迁移文件，不使用无法审计的通配符：

```bash
cat \
  /opt/ragent/releases/<release-tag>/migrations/<migration-1.sql> \
  /opt/ragent/releases/<release-tag>/migrations/<migration-2.sql> \
  | docker exec -i shared-postgres psql \
      -X -v ON_ERROR_STOP=1 --single-transaction \
      -U postgres -d ragent -f -
```

执行后再次查询字段、约束、默认值、回填数量和关键业务记录数。任何核验不符合预期时，不进入容器切换。

## 11. 上传发布产物

先在服务器建立独立暂存目录：

```bash
install -d -m 755 \
  /opt/ragent/releases/<release-tag>/bootstrap/target \
  /opt/ragent/releases/<release-tag>/mcp-server/target \
  /opt/ragent/releases/<release-tag>/frontend \
  /opt/ragent/releases/<release-tag>/deploy
```

从本地上传：

- `bootstrap/target/bootstrap-0.0.1-SNAPSHOT.jar`
- `mcp-server/target/mcp-server-0.0.1-SNAPSHOT.jar`
- `frontend/dist`
- `deploy/cloud`
- `.dockerignore`
- 本次迁移文件

不要上传或覆盖服务器 `.env`。

上传后对 JAR、`frontend/dist` 和 `deploy/cloud` 中的文件计算 SHA256，并与本地清单逐项比较。只有全部一致才能构建镜像。

## 12. 构建运行时镜像

为了避免服务器上的备份目录进入 Docker 构建上下文，使用独立版本目录构建，并通过环境变量覆盖新标签：

```bash
release_tag=<release-tag>
release_root=/opt/ragent/releases/${release_tag}
current_env=/opt/ragent/deploy/cloud/.env

RAGENT_IMAGE_TAG="$release_tag" docker compose \
  --env-file "$current_env" \
  -f "$release_root/deploy/cloud/compose.yaml" \
  -f "$release_root/deploy/cloud/compose.infra.yaml" \
  config --quiet

RAGENT_IMAGE_TAG="$release_tag" docker compose \
  --env-file "$current_env" \
  -f "$release_root/deploy/cloud/compose.yaml" \
  -f "$release_root/deploy/cloud/compose.infra.yaml" \
  build backend mcp-server web
```

旧容器在构建期间继续运行。构建结束后确认新旧镜像同时存在：

```bash
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' |
  grep '^ragent-' |
  sort
```

可从镜像内部反查产物哈希：

```bash
docker run --rm --entrypoint sha256sum \
  ragent-backend:<release-tag> /app/app.jar

docker run --rm --entrypoint sha256sum \
  ragent-mcp-server:<release-tag> /app/app.jar

docker run --rm --entrypoint sha256sum \
  ragent-web:<release-tag> \
  /usr/share/nginx/html/index.html \
  /usr/share/nginx/html/favicon.svg
```

## 13. 安装配置并切换版本

### 13.1 更新服务器构建上下文

将已校验文件从版本目录安装到 `/opt/ragent`。前端目录使用同一文件系统内的重命名完成切换，并保留旧目录：

```bash
release_tag=<release-tag>
release_root=/opt/ragent/releases/${release_tag}

install -m 0644 \
  "$release_root/bootstrap/target/bootstrap-0.0.1-SNAPSHOT.jar" \
  /opt/ragent/bootstrap/target/bootstrap-0.0.1-SNAPSHOT.jar

install -m 0644 \
  "$release_root/mcp-server/target/mcp-server-0.0.1-SNAPSHOT.jar" \
  /opt/ragent/mcp-server/target/mcp-server-0.0.1-SNAPSHOT.jar

install -m 0644 "$release_root/.dockerignore" /opt/ragent/.dockerignore
cp -a "$release_root/deploy/cloud/." /opt/ragent/deploy/cloud/

test ! -e "/opt/ragent/frontend/dist.new-${release_tag}"
test ! -e "/opt/ragent/frontend/dist.pre-${release_tag}"
cp -a "$release_root/frontend/dist" "/opt/ragent/frontend/dist.new-${release_tag}"
mv /opt/ragent/frontend/dist "/opt/ragent/frontend/dist.pre-${release_tag}"
mv "/opt/ragent/frontend/dist.new-${release_tag}" /opt/ragent/frontend/dist
```

版本目录中不得存在 `.env`。复制部署目录后，确认生产 `.env` 仍为 `0600`，且密钥没有发生变化。

### 13.2 修改镜像标签

只修改 `.env` 中的 `RAGENT_IMAGE_TAG`：

```bash
cd /opt/ragent/deploy/cloud
sed -i 's/^RAGENT_IMAGE_TAG=.*/RAGENT_IMAGE_TAG=<release-tag>/' .env
chmod 600 .env
grep '^RAGENT_IMAGE_TAG=' .env

docker compose --env-file .env \
  -f compose.yaml \
  -f compose.infra.yaml \
  config --quiet
```

### 13.3 滚动替换容器

```bash
docker compose --env-file .env \
  -f compose.yaml \
  -f compose.infra.yaml \
  up -d --no-build --wait --wait-timeout 420
```

这一步会依次替换 MCP、Backend 和 Web。Redis、PostgreSQL、RustFS 和 RocketMQ 不应被重建。

不要为了升级执行 `docker compose down`，更不能执行 `docker compose down -v`。

## 14. 发布后验收

### 14.1 容器与镜像

```bash
cd /opt/ragent/deploy/cloud

docker compose --env-file .env -f compose.yaml -f compose.infra.yaml ps
docker compose --env-file .env -f compose.yaml -f compose.infra.yaml images

docker inspect -f \
  '{{.Name}} image={{.Config.Image}} restart={{.RestartCount}} health={{.State.Health.Status}}' \
  ragent-cloud-mcp-server-1 \
  ragent-cloud-backend-1 \
  ragent-cloud-web-1 \
  ragent-cloud-redis-1
```

所有服务应为 `healthy`，新容器的 `RestartCount` 应为 0。

### 14.2 HTTP 和品牌

```bash
curl -fsS http://127.0.0.1:19080/healthz
curl -fsS http://127.0.0.1:19080/ | grep -F 'NexusQA 智能问答'
curl -fsS https://rag.785777.xyz/healthz
curl -fsS https://rag.785777.xyz/ | grep -F 'NexusQA 智能问答'
```

再验证：

- 主 JS 和 favicon 返回 HTTP 200。
- `/api/ragent/user/me` 能通过网关到达 Backend；未登录时业务响应应为未登录，而不是 502 或连接失败。
- 登录页用户名和密码输入框状态正确。
- 管理后台、聊天页和审计页显示 NexusQA 标识。
- 静态资源和 RustFS 预览地址可访问。

### 14.3 日志和资源

```bash
docker compose --env-file .env \
  -f compose.yaml \
  -f compose.infra.yaml \
  logs --since=15m --no-color --tail=500 backend mcp-server web

docker stats --no-stream \
  ragent-cloud-mcp-server-1 \
  ragent-cloud-backend-1 \
  ragent-cloud-web-1 \
  ragent-cloud-redis-1

free -h
df -h /
```

重点检查：

- `ERROR`、未处理异常、启动失败和 OOM。
- PostgreSQL、Redis、RustFS、RocketMQ 是否连接成功。
- MCP 是否返回并注册预期工具。
- Cloud 模型档位配置是否通过校验。
- Backend 和 MCP 是否持续重启。
- 内存、Swap 和磁盘是否接近耗尽。

### 14.4 数据核验

重新检查迁移结构、回填数量和发布前记录数。至少观察 5 分钟，确认没有延迟出现的重启或错误后，才能宣布发布完成。

## 15. 回滚

### 15.1 应用镜像回滚

确保旧镜像仍存在，然后只把 `.env` 中的标签改回旧值：

```bash
cd /opt/ragent/deploy/cloud
sed -i 's/^RAGENT_IMAGE_TAG=.*/RAGENT_IMAGE_TAG=<previous-tag>/' .env

docker compose --env-file .env \
  -f compose.yaml \
  -f compose.infra.yaml \
  config --quiet

docker compose --env-file .env \
  -f compose.yaml \
  -f compose.infra.yaml \
  up -d --no-build --wait --wait-timeout 420
```

再次执行完整验收。不要删除失败版本镜像和日志，保留它们用于排查。

### 15.2 数据库回滚

如果迁移仅新增兼容字段或表，应用回滚后通常不应恢复数据库，否则会丢失发布后的新数据。

只有以下条件全部满足时才恢复数据库：

- 迁移是破坏性的，旧版本无法使用新结构。
- 已停止应用写入。
- 已明确发布后数据的处理方式。
- 已验证备份和恢复命令。
- 已获得负责人确认。

数据库和 RustFS 恢复属于独立事故操作，不应与普通镜像回滚绑定执行。

## 16. 发布记录模板

每次发布完成后记录以下信息，可以放入 PR、Issue 或 `docs/releases`：

```markdown
## Cloud release YYYY-MM-DD

- Release branch:
- Commit SHA:
- Previous image tag:
- New image tag:
- Upstream range:
- Local changes:
- Database migrations:
- Backup directory:
- Backend tests:
- Frontend build:
- Artifact SHA256:
- Deployment started at:
- Deployment completed at:
- Container health:
- HTTP/API checks:
- Database checks:
- Resource usage:
- Known warnings:
- Rollback result or rollback tag:
```

## 17. 发布完成标准

只有下面项目全部满足，发布任务才算完成：

- 发布提交已推送到私有 `origin`。
- 本地测试和生产构建通过。
- NexusQA 可见品牌未被上游覆盖。
- 备份存在且哈希、格式验证通过。
- 仅执行了确认缺失的增量迁移。
- 上传产物与本地 SHA256 一致。
- 新镜像使用 Commit SHA 标签。
- 新容器全部健康且无重启。
- 公网首页、静态资源和 API 验证通过。
- 日志无新的严重错误。
- 数据量和迁移结果符合预期。
- 旧镜像和回滚标签仍保留。
- `.env` 权限为 `0600`，备份目录权限为 `0700`。
