#!/bin/bash
# Runs once, on first initialisation of the Postgres data volume.
# Creates the KyoubeAI organisation database and its login role.
set -euo pipefail
: "${KYOUBE_DB_PASSWORD:?KYOUBE_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 -v pw="$KYOUBE_DB_PASSWORD" -v core="$POSTGRES_DB" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
  -- CREATEROLE is needed because the apps plugin creates one NOLOGIN role per company.
  CREATE ROLE kyoube LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT;
  CREATE DATABASE kyoube OWNER kyoube;
  REVOKE CONNECT ON DATABASE :"core" FROM PUBLIC;
  REVOKE CONNECT ON DATABASE kyoube FROM PUBLIC;
EOSQL
