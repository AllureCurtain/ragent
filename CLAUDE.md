# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Ragent is a front/back separated Agentic RAG platform built around a Java 17 Spring Boot backend and a React 18 + Vite frontend. The backend is a multi-module Maven project with a separate MCP server.

Key architectural expectations from the repository:
- Treat this as a production-oriented RAG system, not a demo.
- Preserve the module boundaries between shared framework code, AI provider integrations, and business/application logic.
- Prefer extending existing plug-in points over adding special-case logic into core orchestration.
- Important runtime features include multi-channel retrieval, query rewrite, intent recognition, conversation memory, model routing/failover, MCP tool execution, ingestion pipelines, and traceability.

## Repository structure

### Backend modules
- `framework` — shared infrastructure used by the main application: web conventions, global exception handling, result wrappers, DB config, ID generation, idempotency support, and RAG trace annotations/context.
- `infra-ai` — provider-agnostic AI integration layer. Contains `ChatClient`, embedding/rerank clients, routing services, provider implementations (Bailian, SiliconFlow, Ollama), stream handling, and model health/routing logic.
- `bootstrap` — main Spring Boot business application. Holds controllers, services, DAOs, domain logic for chat/RAG, ingestion, knowledge base management, admin pages, user/auth flows, parsing, and chunking.
- `mcp-server` — separate Spring Boot process exposing MCP tool endpoints consumed by the main app.

### Frontend
- `frontend` — React 18 + Vite + TypeScript admin/chat UI.
- Routing is centralized in `frontend/src/router.tsx`.
- API access is centralized through `frontend/src/services/api.ts`.
- Client state is managed with Zustand stores under `frontend/src/stores`.

### Other important paths
- `bootstrap/src/main/resources/application.yaml` — main backend runtime config.
- `mcp-server/src/main/resources/application.yml` — MCP server config.
- `resources/database/schema_table.sql` — initial database/bootstrap SQL. Do not treat this as an idempotent migration script.
- `resources/format/copyright.txt` — Spotless Java license header source.

## Development commands

### Backend: Maven multi-module
Use the Maven wrapper from the repo root.

- Build all backend modules:
  - `./mvnw clean install`
- Run all backend tests:
  - `./mvnw test`
- Run tests for the main app module only:
  - `./mvnw -pl bootstrap test`
- Run a single backend test class:
  - `./mvnw -pl bootstrap -Dtest=IntentTreeServiceTests test`
- Run a single backend test method:
  - `./mvnw -pl bootstrap -Dtest=IntentTreeServiceTests#someMethod test`
- Start the main backend app:
  - `./mvnw -pl bootstrap spring-boot:run`
- Start the MCP server:
  - `./mvnw -pl mcp-server spring-boot:run`
- Apply Java formatting explicitly:
  - `./mvnw spotless:apply`

On Windows, use `mvnw.cmd` instead of `./mvnw`.

### Frontend
Run from `frontend/`.

- Install dependencies:
  - `npm install`
- Start the dev server:
  - `npm run dev`
- Build the frontend:
  - `npm run build`
- Lint the frontend:
  - `npm run lint`
- Format the frontend:
  - `npm run format`
- Preview the production build:
  - `npm run preview`
- Note: the frontend currently defines dev/build/lint/format/preview scripts, but no checked-in frontend test script.

## Local runtime configuration

Default local ports/configuration visible in checked-in config:
- Main backend: `http://localhost:9090/api/ragent`
- Frontend dev server: `http://localhost:5173`
- MCP server: `http://localhost:9099`
- MySQL default: `127.0.0.1:3306/ragent`
- Redis default: `127.0.0.1:6379`
- Milvus default: `http://localhost:19530`
- RustFS/S3 default: `http://localhost:9000`
- Ollama default: `http://localhost:11434`

Frontend currently uses the checked-in `frontend/.env` value `VITE_API_BASE_URL=http://localhost:9090/api/ragent`, so API calls default to the full backend base URL. `frontend/vite.config.ts` also proxies `/api` to `http://localhost:9090`, which is only useful if the frontend is switched to a relative `/api` base.

Main backend config also expects optional model-provider credentials via environment variables such as:
- `BAILIAN_API_KEY`
- `SILICONFLOW_API_KEY`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_DATABASE`
- `MYSQL_USERNAME`
- `MYSQL_PASSWORD`

Checked-in values such as MySQL `root/root` defaults and RustFS `rustfsadmin/rustfsadmin` are local-development defaults only. Do not reuse them in production; prefer environment overrides for secrets.

Minimum local backend dependencies for meaningful end-to-end behavior are MySQL, Redis, Milvus, and RustFS/S3-compatible storage. Ollama/Bailian/SiliconFlow are optional model providers depending on which chat/embedding/rerank paths you want to exercise.

## Architecture notes for future changes

### Main backend startup and boundaries
- The main application entrypoint is `bootstrap/src/main/java/com/nageoffer/ai/ragent/RagentApplication.java`.
- It enables scheduling and scans MyBatis mappers for RAG, ingestion, knowledge, and user domains.
- Keep reusable infrastructure in `framework`, provider integration in `infra-ai`, and product/domain logic in `bootstrap`.

### RAG/chat flow
The backend is organized around a full RAG conversation pipeline rather than a thin controller-service wrapper. Important subsystems live under `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag` and related packages:
- intent recognition
- query rewrite / multi-question rewrite
- retrieval channels
- rerank/post-processing pipeline
- conversation/session memory
- streaming chat responses
- feedback/tracing

The `framework.trace` and `@RagTraceNode` infrastructure are part of the intended flow; avoid bypassing trace capture when changing core RAG execution.

### AI provider abstraction
`infra-ai` is the indirection layer between business logic and model vendors.
- Chat models implement/provider-bind through `ChatClient` and related routing services.
- Embedding and rerank follow the same routed/provider-aware pattern.
- Model routing includes failure thresholds, open-duration/circuit behavior, candidate priorities, and stream-first-packet handling.

When adding a model/provider, follow the existing routed client pattern instead of embedding provider-specific HTTP calls inside business services.

### Ingestion pipeline
Document ingestion is a configurable pipeline, not a single service method.
- Core orchestration is under `bootstrap/.../ingestion/engine`.
- Pipeline nodes are under `bootstrap/.../ingestion/node`.
- Pipeline/task definitions and settings live under `bootstrap/.../ingestion/domain`.
- Fetchers, parsers, chunkers, enrichers, and indexers are separated so they can be composed and logged independently.

Prefer extending pipeline nodes/strategies over adding one-off code paths.

### Knowledge base and chunking
Knowledge base management, documents, and chunk operations are separate backend areas under `bootstrap/.../knowledge`.
Chunking and parsing are also intentionally separated into reusable packages:
- `core/parser`
- `core/chunk`

If changing ingestion or retrieval behavior, check both the document parsing/chunk generation side and the retrieval/index side.

### MCP integration
The main app is configured to call external MCP servers under `rag.mcp.servers`, with the checked-in default pointing at the local `mcp-server` module on port `9099`.
If a change touches tool execution, inspect both sides:
- consumer/orchestration in the main app
- JSON-RPC tool exposure and registry in `mcp-server`

### Frontend shape
Frontend navigation splits into:
- public/auth routes (`/login`)
- chat routes (`/chat`, `/chat/:sessionId`)
- admin routes under `/admin`

The frontend API client in `frontend/src/services/api.ts` assumes a backend response envelope with `code`, `message`, and `data`, and unwraps successful responses when `code === "0"`. Do not casually change backend response semantics without checking frontend interceptor behavior.

Admin UI covers dashboard, knowledge management, intent tree management, ingestion, traces, settings, sample questions, and users. When adding a new page/feature, follow the existing pattern:
- page under `frontend/src/pages/...`
- API wrapper under `frontend/src/services/...`
- shared state in Zustand store only when state must outlive a single page/component

## Extension points worth reusing
README documents these as intended customization points:
- `SearchChannel`
- `SearchResultPostProcessor`
- `MCPToolExecutor`
- `IngestionNode`
- `ChatClient`

Prefer implementing/extending these over rewriting existing orchestration.

## Practical cautions
- `resources/database/schema_table.sql` creates the initial schema/database, but is not a safe repeatable migration.
- The backend depends on external infrastructure and model services; test failures may be environment-related if MySQL, Redis, Milvus, S3 storage, Ollama, or remote provider credentials are unavailable.
- Spotless runs during Maven compile, so Java formatting/header issues may surface as part of normal builds.
