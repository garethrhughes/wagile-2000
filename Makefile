.PHONY: install up down migrate seed dev-api dev-web test-api test-web sync start stop clean reset \
        tf-plan tf-apply ecr-push

# ── Deploy ──────────────────────────────────────────────────────────────────
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
