import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Hardhat's public development mnemonic. Only used against a local dev chain
# (chainId 31337); on public networks set ACTOR_KEY_<NAME> env vars instead.
HARDHAT_MNEMONIC = "test test test test test test test test test test test junk"


class Settings:
    rpc_url = os.getenv("RPC_URL", "http://127.0.0.1:8545")
    deployment_file = Path(os.getenv("DEPLOYMENT_FILE", ROOT / "shared" / "deployment.json"))
    data_dir = Path(os.getenv("DATA_DIR", ROOT / "backend" / "data"))
    claude_model = os.getenv("CLAUDE_MODEL", "claude-opus-5")
    anthropic_key_set = bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))
    ai_disabled = os.getenv("AI_DISABLED", "").lower() in ("1", "true", "yes")
    electricitymaps_token = os.getenv("ELECTRICITYMAPS_TOKEN")
    public_base_url = os.getenv("PUBLIC_BASE_URL", "http://localhost:5173")
    cors_origins = os.getenv("CORS_ORIGINS", "*").split(",")


settings = Settings()
