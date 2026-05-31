#!/bin/sh
set -e

echo "Running Postgres migrations..."
pnpm run migrate

echo "Running ClickHouse migrations..."
pnpm run migrate-clickhouse

echo "Starting API server..."
exec node dist/index.js
