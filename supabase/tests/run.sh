#!/usr/bin/env bash
# Runs the schema and behaviour tests against a throwaway local Postgres database.
# Usage: PGHOST=/tmp PGPORT=54329 PGUSER=postgres ./tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -v ON_ERROR_STOP=1 -q -t -A"
$P -d postgres -c "drop database if exists booking_test" -c "create database booking_test" 2>/dev/null
P="$P -d booking_test"
$P -f tests/00_stub_supabase.sql
$P -f migrations/0001_init.sql
$P -f tests/02_scenarios.sql 2>&1 | grep -E "ok  -|FAILED|ERROR|PASSED" || true
