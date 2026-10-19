import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Hardhat's public development mnemonic. Only used against a local dev chain
# (chainId 31337); on public networks set ACTOR_KEY_<NAME> env vars instead.
HARDHAT_MNEMONIC = "test test test test test test test test test test test junk"


def _load_env() -> None:
    """Read ../.env (KEY=value) without overriding existing environment variables."""
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()


class Settings:
    rpc_url = os.getenv("RPC_URL", "http://127.0.0.1:8545")
    testnet_mnemonic = os.getenv("TESTNET_MNEMONIC", "")
    deployment_file = Path(os.getenv("DEPLOYMENT_FILE", ROOT / "shared" / "deployment.json"))
    data_dir = Path(os.getenv("DATA_DIR", ROOT / "backend" / "data"))
    claude_model = os.getenv("CLAUDE_MODEL", "claude-opus-5")
    # API key, auth token, or a local `ant auth login` / Claude Code OAuth profile (picked up by the SDK automatically)
    anthropic_key_set = bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN") or os.getenv("ANTHROPIC_PROFILE")
                             or (Path.home() / ".config" / "anthropic" / "credentials" / "default.json").exists())
    ai_disabled = os.getenv("AI_DISABLED", "").lower() in ("1", "true", "yes")
    electricitymaps_token = os.getenv("ELECTRICITYMAPS_TOKEN")
    public_base_url = os.getenv("PUBLIC_BASE_URL", "http://localhost:5173")
    cors_origins = os.getenv("CORS_ORIGINS", "*").split(",")


settings = Settings()
