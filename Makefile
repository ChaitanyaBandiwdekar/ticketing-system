# Shortcuts for the common loops. Everything here is also a plain npm script or a compose command.
.PHONY: install check test up down smoke burst burst-small obs

URL ?= http://localhost:8080
ADMIN_API_KEY ?= local-dev-admin-key

install:
	npm ci

## Format, lint, typecheck and the full test suite (embedded Postgres; no Docker needed).
check:
	npm run format:check && npm run lint && npm run typecheck && npm test

test:
	npm test

## Postgres 17 + PgBouncer + the app on :8080 (docker-compose.yml).
up:
	docker compose up -d --build --wait

down:
	docker compose down

## Prometheus on :9090 and Grafana on :3000 next to the stack.
obs:
	docker compose --profile obs up -d --wait

smoke:
	scripts/smoke.sh $(URL) $(ADMIN_API_KEY)

## The full stampede (20k requests). Override: make burst URL=https://fdfs-dkyx.onrender.com ADMIN_API_KEY=...
burst:
	ADMIN_API_KEY=$(ADMIN_API_KEY) npm run burst -- $(URL)

burst-small:
	ADMIN_API_KEY=$(ADMIN_API_KEY) npm run burst -- $(URL) --small
