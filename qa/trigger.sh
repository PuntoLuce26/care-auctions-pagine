#!/bin/bash
# Trigger del QA cloud dopo un deploy nostro (edge/worker) o a mano.
# Uso: bash qa/trigger.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_FILE="$ROOT/.tools/github-token.txt"
if [ ! -f "$TOKEN_FILE" ]; then echo "token GitHub non trovato: $TOKEN_FILE"; exit 1; fi
TOKEN="$(cat "$TOKEN_FILE")"
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: CARe-QA-trigger" \
  "https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/actions/workflows/qa.yml/dispatches" \
  -d '{"ref":"main"}' \
  -o /tmp/qa-trigger.out -w "HTTP %{http_code}\n"
head -c 300 /tmp/qa-trigger.out; echo
