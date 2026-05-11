# pi-litellm

LiteLLM integration extensions for [Pi](https://github.com/earendil-works/pi-coding-agent). Provides model sync, accurate cost tracking, and session grouping when routing Pi through a LiteLLM proxy.

## Features

### Model Sync (`litellm-sync.ts`)

Keeps the Pi model selector in sync with LiteLLM's live model list. On startup (and on `/reload`), it tries `GET /model/info` first for rich metadata and falls back to `GET /v1/models` when LiteLLM virtual keys cannot access the admin endpoint.

**Before:** `claude-opus-4.6 [litellm]` (stale, doesn't match LiteLLM routing names)
**After:** `bedrock/claude-opus-4.6 [litellm]`, `openrouter/claude-sonnet-4.6 [litellm]`

Model costs, context windows, max output tokens, reasoning support, and vision support come from `/model/info` when available. Fallback models keep the exact LiteLLM IDs and use conservative defaults. Anthropic and Claude aliases are registered with Anthropic cache-control compatibility so Pi can pass prompt cache markers through LiteLLM.

### Cost Tracking (`litellm-cost.ts`)

Overrides Pi's static cost calculation with accurate pricing from LiteLLM:

1. **Response header** — Reads `x-litellm-response-cost` from each LLM response for exact per-request cost.
2. **Model pricing fallback** — At startup, fetches model pricing from LiteLLM's `/model/info` endpoint. When the response header isn't available (e.g., streaming), calculates cost from token counts × per-token rates.

### Session Grouping (`litellm-session.ts`)

Injects `litellm_session_id` into every outgoing request payload so all API calls within one Pi session are grouped in LiteLLM's session logs. The session ID is derived from the Pi session filename.

Requires `drop_params: true` in your LiteLLM `litellm_settings` config.

## Installation

```bash
pi install git:github.com/xec-abailey/pi-litellm
```

Or in `.pi/settings.json`:

```json
{
  "packages": ["git:github.com/xec-abailey/pi-litellm"]
}
```

To update after pushing changes:

```bash
pi update git:github.com/xec-abailey/pi-litellm
```

## Local Extension Development

For active development, switch from the git source to a local path so edits are picked up immediately on `/reload` without needing to commit and push.

### Setup

```bash
# Clone to ~/projects (skip if already exists)
[ -d ~/projects/pi-litellm ] || git clone https://github.com/xec-abailey/pi-litellm.git ~/projects/pi-litellm

# Switch the project settings to use the local path
cd <your-project>
sed -i 's|"git:github.com/xec-abailey/pi-litellm"|"../../projects/pi-litellm"|' .pi/settings.json
```

Then `/reload` in Pi. Edits to `~/projects/pi-litellm/extensions/` are live immediately.

### Switch back to git source

```bash
cd <your-project>
sed -i 's|"../../projects/pi-litellm"|"git:github.com/xec-abailey/pi-litellm"|' .pi/settings.json
```

### Helper script

A convenience script is provided at `scripts/dev.sh`:

```bash
# Enter local dev mode
./scripts/dev.sh local

# Switch back to git source
./scripts/dev.sh git

# Check current mode
./scripts/dev.sh status
```

## Configuration

Set environment variables (or configure in `~/.pi/agent/models.json`):

| Variable | Default | Description |
|----------|---------|-------------|
| `LITELLM_BASE_URL` | `http://localhost:4000` | LiteLLM proxy URL, with or without a trailing `/v1` |
| `LITELLM_API_KEY` | `sk-cedar-local` | LiteLLM API key |
| `LITELLM_DISCOVERY_TIMEOUT_MS` | `5000` | Model discovery timeout in milliseconds; `0` skips startup discovery |
| `LITELLM_OFFLINE` | unset | If `1`, skips network discovery and uses the model cache |

You can also run `/login litellm` inside Pi. Stored Pi credentials take precedence over environment variables. Environment variables take precedence over `models.json`, which takes precedence over the local defaults above.

Use `/litellm-refresh` inside Pi to force a fresh model discovery without restarting.

### models.json (optional)

If you prefer file-based config over env vars, add a `litellm` provider entry to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "litellm": {
      "baseUrl": "http://localhost:4000",
      "api": "openai-completions",
      "apiKey": "sk-cedar-local"
    }
  }
}
```

The sync extension reads `baseUrl`, `apiKey`, and `api` from this config. You do **not** need to define models here — they're populated dynamically from LiteLLM and cached at `~/.pi/agent/litellm-models.json`.

Priority: stored `/login litellm` credentials > environment variables > models.json > defaults.

## LiteLLM Setup

Your LiteLLM `config.yaml` should include:

```yaml
litellm_settings:
  drop_params: true
```

This ensures:
- `litellm_session_id` is stripped before forwarding to upstream providers
- Unknown params from Pi don't cause upstream errors

## How Model Sync Works

1. Extension loads as an async factory (runs before `session_start`)
2. Fetches `GET /model/info` from LiteLLM when available, otherwise falls back to `GET /v1/models`
3. Calls `pi.registerProvider("litellm", { models: [...] })` with those exact IDs
4. Writes the discovered list to `~/.pi/agent/litellm-models.json`
5. On `/reload` or `/litellm-refresh`, re-fetches and re-registers to pick up config changes

If LiteLLM is unreachable at startup, the extension logs a warning and uses the cached model list when the configured base URL and API key fingerprint still match.

## License

MIT
