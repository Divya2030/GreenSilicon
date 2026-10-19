#!/usr/bin/env bash
# One-command local stack: Hardhat chain -> deploy -> seed demo -> API -> UI.
#   ./scripts/dev.sh          dev mode (Vite on :5173, API on :8000)
#   ./scripts/dev.sh --prod   build the UI and serve everything from :8000
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"; mkdir -p "$LOGS"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

[ -f "$ROOT/.env" ] && { set -a; . "$ROOT/.env"; set +a; }

echo "▸ installing dependencies (first run only)"
[ -d "$ROOT/contracts/node_modules" ] || (cd "$ROOT/contracts" && npm ci --silent)
[ -d "$ROOT/frontend/node_modules" ] || (cd "$ROOT/frontend" && npm ci --silent)
if [ ! -d "$ROOT/backend/.venv" ]; then
  python3 -m venv "$ROOT/backend/.venv"
  "$ROOT/backend/.venv/bin/pip" install -q -r "$ROOT/backend/requirements.txt"
fi

echo "▸ starting local EVM (Hardhat) on :8545"
(cd "$ROOT/contracts" && npx hardhat node > "$LOGS/chain.log" 2>&1) & PIDS+=($!)
for _ in $(seq 1 60); do
  curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://127.0.0.1:8545 >/dev/null && break
  sleep 1
done

echo "▸ deploying contracts"
(cd "$ROOT/contracts" && npx hardhat run scripts/deploy.js --network localhost)

echo "▸ seeding demo supply chain"
(cd "$ROOT/backend" && .venv/bin/python -m app.seed)

if [ "${1:-}" = "--prod" ]; then
  (cd "$ROOT/frontend" && npx vite build --logLevel warn)
  echo "▸ GreenSilicon running at http://localhost:8000"
  cd "$ROOT/backend" && exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
fi

(cd "$ROOT/backend" && .venv/bin/uvicorn app.main:app --port 8000 > "$LOGS/api.log" 2>&1) & PIDS+=($!)
echo "▸ GreenSilicon UI at http://localhost:5173  (API docs: http://localhost:8000/docs)"
cd "$ROOT/frontend" && npx vite --port 5173
