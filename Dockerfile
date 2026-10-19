# Single-container demo: local Hardhat chain + seeded demo + API + built UI on :8000
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY contracts/package*.json contracts/
RUN cd contracts && npm ci
COPY frontend/package*.json frontend/
RUN cd frontend && npm ci
COPY backend/requirements.txt backend/
RUN python3 -m venv backend/.venv && backend/.venv/bin/pip install --no-cache-dir -r backend/requirements.txt
COPY . .
RUN cd contracts && npx hardhat compile
EXPOSE 8000
CMD ["./scripts/dev.sh", "--prod"]
