.PHONY: install up down migrate seed dev-api dev-web test-api test-web sync start stop clean reset \
        tf-plan tf-apply ecr-push lambda-build

# ── Deploy ──────────────────────────────────────────────────────────────────

# lambda-build: compiles the backend and produces backend/snapshot-worker.zip
# containing only production-runtime dependencies. Must be run before tf-apply
# whenever backend source files change. The zip is intentionally placed at
# backend/snapshot-worker.zip (next to dist/, not inside it) so that nest build
# cannot delete it on the next compile.
#
# Why a Makefile target rather than a Terraform null_resource provisioner:
#   - Terraform evaluates filebase64sha256() at plan time, before null_resource
#     runs, causing a two-apply problem on a clean checkout.
#   - local-exec provisioners cannot be safely retried without re-running apply.
#   - Build failures are clearer and faster to fix outside of Terraform.
#
# Usage:
#   make lambda-build   # when backend source changes
#   make tf-apply       # deploy (zip is already present and hash is real)
#   make deploy         # convenience: build then apply
lambda-build:
	@echo "==> Installing backend dependencies (including dev for compilation)..."
	npm ci --prefix backend

	@echo "==> Compiling TypeScript..."
	npm run build --prefix backend

	@echo "==> Creating minimal Lambda runtime install..."
	rm -rf /tmp/lambda-node-modules
	mkdir -p /tmp/lambda-node-modules
	cp backend/package.json /tmp/lambda-node-modules/package.json
	cp backend/package-lock.json /tmp/lambda-node-modules/package-lock.json
	cd /tmp/lambda-node-modules && npm ci --omit=dev

	@echo "==> Packaging Lambda zip..."
	rm -f backend/snapshot-worker.zip
	cd backend/dist && zip -r ../../backend/snapshot-worker.zip . --quiet
	cd /tmp/lambda-node-modules && zip -r $(CURDIR)/backend/snapshot-worker.zip node_modules/ --quiet

	@echo "==> Lambda zip ready at backend/snapshot-worker.zip"
	@echo "    Unzipped size: $$(unzip -l backend/snapshot-worker.zip | tail -1 | awk '{print $$1}') bytes"

deploy: lambda-build tf-apply

tf-plan:
	./scripts/tf-apply.sh --plan-only

tf-apply:
	./scripts/tf-apply.sh

ecr-push:
	./scripts/ecr-push.sh

# ── Local infrastructure ─────────────────────────────────────────────────────
up:
	docker compose up -d

down:
	docker compose down

# Database
migrate:
	cd backend && npm run build && npm run migration:run

seed:
	cd backend && npx ts-node src/database/seed.ts

# Development
dev-api:
	cd backend && npm run start:dev

dev-web:
	cd frontend && npm run dev

# Testing
test-api:
	cd backend && npm test

test-web:
	cd frontend && npm test

# Jira Sync
sync:
	@echo "Triggering manual Jira sync..."
	@curl -s -X POST http://localhost:3001/api/sync \
		-H "x-api-key: $${APP_API_KEY}" \
		-H "Content-Type: application/json" | head -c 500
	@echo

# Legacy targets
install:
	cd backend && npm install
	cd frontend && npm install

start: up
	cd backend && npm run start:dev &
	cd frontend && npm run dev &

stop:
	-kill $$(lsof -t -i:3001) 2>/dev/null || true
	-kill $$(lsof -t -i:3000) 2>/dev/null || true
	docker compose down

clean: stop
	docker compose down -v
	$(MAKE) up
	sleep 2
	$(MAKE) migrate

reset: stop
	docker compose down -v
	rm -rf backend/node_modules backend/dist frontend/node_modules frontend/.next
	$(MAKE) install
	$(MAKE) up
	sleep 2
	$(MAKE) migrate
