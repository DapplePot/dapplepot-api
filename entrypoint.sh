#!/bin/sh
set -e

echo "Running database migrations..."
pnpm run migrate

echo "Starting API server..."
exec node dist/index.js
