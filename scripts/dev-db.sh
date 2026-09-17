#!/usr/bin/env bash
# Starts a throwaway Postgres 17 for integration tests and prints the URL to export.
set -euo pipefail
docker rm -f kyoube-dev-db >/dev/null 2>&1 || true
docker run -d --name kyoube-dev-db -e POSTGRES_PASSWORD=dev -p 5433:5432 postgres:17-alpine >/dev/null
for i in $(seq 1 30); do docker exec kyoube-dev-db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
echo "export KYOUBE_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres"
