# pi-litellm

LiteLLM integration extensions for [Pi](https://github.com/earendil-works/pi-coding-agent). Provides model sync, accurate cost tracking, and session grouping when routing Pi through a LiteLLM proxy.

## Features

### Model Sync (`litellm-sync.ts`)

Keeps the Pi model selector in sync with LiteLLM's live model list. On startup (and on `/reload`), fetches `GET /v1/models` from LiteLLM and registers the provider with the exact model IDs that LiteLLM exposes.

**Before:** `claude-opus-4.6 [litellm]` (stale, doesn't match LiteLLM routing names)
**After:** `bedrock/claude-opus-4.6 [litellm]`, `openrouter/claude-sonnet-4.6 [litellm]`

Model capabilities (reasoning, context window, max tokens, thinking levels) are auto-detected from the model ID.

### Cost Tracking (`litellm-cost.ts`)

Overrides Pi's static cost calculation with accurate pricing from LiteLLM:

1. **Response header** — Reads `x-litellm-response-cost` from each LLM response for exact per-request cost.
2. **Model pricing fallback** — At startup, fetches model pricing from LiteLLM's `/model/info` endpoint. When the response header isn't available (e.g., streaming), calculates cost from token counts × per-token rates.

### Session Grouping (`litellm-session.ts`)

Injects `litellm_session_id` into every outgoing request payload so all API calls within one Pi session are grouped in LiteLLM's session logs. The session ID is derived from the Pi session filename.

Requires `drop_params: true` in your LiteLLM `litellm_settings` config.

## Installation

```bash
pi install npm:pi-litellm
```

Or in `.pi/settings.json`:

```json
{
  "packages": ["npm:pi-litellm"]
}
```

## Configuration

Set environment variables (or configure in `~/.pi/agent/models.json`):

| Variable | Default | Description |
|----------|---------|-------------|
| `LITELLM_BASE_URL` | `http://localhost:4000` | LiteLLM proxy URL |
| `LITELLM_API_KEY` | `sk-cedar-local` | LiteLLM API key |

### models.json (optional)

If you prefer file-based config over env vars, add a `litellm` provider entry to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "litellm": {
      "baseUrl": "http://localhost:4000",
      "api": "anthropic-messages",
      "apiKey": "sk-cedar-local"
    }
  }
}
```

The sync extension reads `baseUrl`, `apiKey`, and `api` from this config. You do **not** need to define models here — they're populated dynamically from LiteLLM.

Priority: environment variables > models.json > defaults.

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
2. Fetches `GET /v1/models` from LiteLLM → returns `model_name` values from config.yaml
3. Calls `pi.registerProvider("litellm", { models: [...] })` with those exact IDs
4. On `/reload`, re-fetches and re-registers to pick up config changes

If LiteLLM is unreachable at startup, the extension logs a warning and skips registration — Pi continues with whatever models are already configured.

## License

MIT
