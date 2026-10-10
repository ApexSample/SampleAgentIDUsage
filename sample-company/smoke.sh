#!/bin/sh
set -eu

directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose="docker compose -f ${directory}/compose.yaml"
incident_url="http://127.0.0.1:${INCIDENT_PORT:-4102}/v1/incidents"
checkout_url="http://127.0.0.1:${CHECKOUT_PORT:-4100}/v1/orders/SKU-100"

cleanup() {
  if [ "${KEEP_SAMPLE_COMPANY:-0}" = "1" ]; then
    $compose start inventory-api >/dev/null 2>&1 || true
  else
    $compose down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

wait_for() {
  description="$1"
  shift
  attempts=0
  until "$@" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 40 ]; then
      echo "Timed out waiting for ${description}" >&2
      return 1
    fi
    sleep 1
  done
}

incident_has_status() {
  expected="$1"
  curl -fsS -H "authorization: Bearer sample-company-incident-reader" "$incident_url" |
    grep -q "\"status\":\"${expected}\""
}

checkout_succeeds() {
  curl -fsS -X POST "$checkout_url" | grep -q '"status":"accepted"'
}

$compose up -d --build
wait_for "checkout API" curl -fsS http://127.0.0.1:${CHECKOUT_PORT:-4100}/health

checkout_succeeds
$compose stop inventory-api >/dev/null

http_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$checkout_url")
if [ "$http_status" != "503" ]; then
  echo "Expected checkout HTTP 503 while inventory was stopped; got ${http_status}" >&2
  exit 1
fi
wait_for "open incident" incident_has_status open

$compose start inventory-api >/dev/null
wait_for "checkout recovery" checkout_succeeds
wait_for "resolved incident" incident_has_status resolved

echo "Sample company outage workflow passed."