# pi-litellm

LiteLLM integration extensions for [Pi](https://github.com/earendil-works/pi-coding-agent). Provides accurate cost tracking and session grouping when routing Pi through a LiteLLM proxy.

## Features

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

Set environment variables (or use defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `LITELLM_BASE_URL` | `http://localhost:4000` | LiteLLM proxy URL |
| `LITELLM_API_KEY` | `sk-cedar-local` | LiteLLM API key |

## LiteLLM Setup

For session grouping, add to your LiteLLM `config.yaml`:

```yaml
litellm_settings:
  drop_params: true
```

This ensures `litellm_session_id` is stripped before forwarding to upstream providers.

## License

MIT
