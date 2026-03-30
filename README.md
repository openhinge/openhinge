# OpenHinge

Self-hosted AI gateway that unifies multiple LLM providers behind a single OpenAI-compatible API.

Use your own subscriptions (Claude Pro, ChatGPT Plus, Gemini) and API keys. Control access with API keys, rate limits, and budget controls. Route requests through AI personas ("souls") with dedicated system prompts and endpoints.

## Features

- **Multi-provider** — Claude, OpenAI, Gemini, Ollama. Multiple accounts of the same type supported.
- **OAuth login** — Use your existing subscriptions. Click "Login with Claude/OpenAI/Gemini" to authenticate via browser. Tokens auto-refresh when they expire.
- **Souls** — AI personas with system prompts, dedicated endpoints, and configurable models/temperature.
- **Dual API compatibility** — OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) endpoints. Works with any SDK.
- **Tool calling** — Full tool/function calling support across both API formats, including streaming.
- **Extended thinking** — Claude thinking blocks passed through in Anthropic format.
- **Streaming** — Full SSE streaming support in both OpenAI and Anthropic formats.
- **API key management** — `ohk_` prefixed keys with rate limits, soul binding, budget controls, and expiry.
- **Request logging** — Every request logged with tokens, latency, cost. Searchable, filterable, paginated.
- **Dashboard** — Web UI for managing providers, souls, keys, logs, and settings.
- **Fallback routing** — Providers have priority. If one fails, the next healthy provider handles the request.
- **Health monitoring** — Per-provider health checks that don't consume generation quota.
- **Background token refresh** — OAuth tokens refreshed every 15 min automatically.
- **Cloudflare Tunnel** — Expose your gateway over HTTPS without opening ports.
- **CLI** — Full command-line interface for setup and management.
- **Zero external dependencies** — Embedded SQLite, no Redis/Postgres/Docker required.
- **Multi-account providers** — Add unlimited accounts of the same type (e.g., 10 Claude subscriptions). Automatic fallback between them.
- **OpenClaw integration** — Auto-detect and configure OpenClaw from CLI or dashboard.
- **Self-update** — `openhinge update` pulls latest, rebuilds, migrates, and auto-restarts the server. Works even if the binary is broken.
- **Self-healing** — If the CLI crashes, it auto-rebuilds from source and retries.

## Quick Start

```bash
curl -fsSL https://openhinge.com/install.sh | bash
```

That's it. The installer clones, builds, starts the server, and opens the dashboard in your browser. Set a password on first visit to get started.

Or manually:

```bash
git clone https://github.com/openhinge/openhinge.git
cd openhinge
npm install
npm run build
npm start
```

## Setup

### 1. Add a Provider

Go to **Providers → Add Provider**. Choose your provider and authenticate:

| Provider | OAuth (Subscription) | API Key |
|----------|---------------------|---------|
| **Claude** | Keychain import, browser OAuth (multiple accounts), or paste token | `sk-ant-api03-...` from console.anthropic.com |
| **OpenAI** | Auto-detects from Codex CLI auth | `sk-...` from platform.openai.com |
| **Gemini** | Browser OAuth with Google account | Key from aistudio.google.com |
| **Ollama** | Auto-detected on localhost:11434 | N/A |

OAuth mode uses your existing subscription (no per-token cost). API key mode uses standard pay-per-token pricing.

### 2. Create a Soul

Go to **Souls → Add Soul**. Configure:

- **Provider & Model** — Which LLM handles this soul
- **System Prompt** — Instructions for the AI's behavior
- **Slug** — Auto-generated URL path (e.g., `translator`)

This creates the endpoint: `POST /v1/souls/{slug}/chat/completions`

### 3. Generate an API Key

Go to **API Keys → Create Key**. Set:

- **Soul binding** — Restrict to specific souls or allow all
- **Rate limit** — Requests per minute (default: 60)

Copy the key immediately — it's only shown once.

### 4. Send a Request

```bash
curl http://localhost:3700/v1/souls/translator/chat/completions \
  -H "Authorization: Bearer ohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Translate to German: Hello"}]}'
```

## CLI Reference

After installation, the `openhinge` command is available globally.

### Server Management

```bash
openhinge start              # Start server in background
openhinge start -f           # Start in foreground (blocks terminal)
openhinge stop               # Stop the server
openhinge restart             # Restart the server
openhinge status              # Show providers, souls, keys, request counts
openhinge logs                # View last 50 lines of server logs
openhinge logs -f             # Follow log output (like tail -f)
openhinge logs -n 100         # Show last 100 lines
```

### Providers

```bash
# List all providers
openhinge provider list

# Add a provider with API key
openhinge provider add -n "OpenAI" -t openai -k sk-xxx -m gpt-4o -p 5
openhinge provider add -n "Claude" -t claude -k sk-ant-api03-xxx -m claude-sonnet-4-6 -p 10
openhinge provider add -n "Gemini" -t gemini -k AIza... -m gemini-2.5-flash
openhinge provider add -n "Local Ollama" -t ollama -u http://localhost:11434 -m qwen3:8b

# Auto-import Claude subscription from this computer's Claude Code credentials
openhinge provider add-claude
openhinge provider add-claude -m claude-opus-4-6 -p 10

# Import Claude subscription from another machine (no Claude Code needed on this machine)
openhinge provider export-claude                    # Run on machine WITH Claude Code
openhinge provider add-claude --token <token>       # Run on remote server

# Refresh Claude subscription tokens
openhinge provider refresh-claude
openhinge provider refresh-claude --id <provider-id>

# Check provider health
openhinge provider health
```

**Provider add options:**

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Provider display name (required) |
| `-t, --type <type>` | Provider type: `claude`, `openai`, `gemini`, `ollama` (required) |
| `-k, --key <key>` | API key or OAuth token |
| `-u, --url <url>` | Custom base URL (for self-hosted or proxies) |
| `-m, --model <model>` | Default model for this provider |
| `-p, --priority <n>` | Priority — higher number = preferred (default: 0) |

**Provider add-claude options:**

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Provider display name |
| `-m, --model <model>` | Default model |
| `-p, --priority <n>` | Priority (default: 10) |
| `--token <token>` | Import token from `export-claude` (for remote servers) |

> **Using subscriptions on remote servers:** Run `openhinge provider export-claude` on a machine where Claude Code is logged in. It outputs a token you can paste on any other machine with `openhinge provider add-claude --token <token>`. No Claude Code or API key needed on the server.

### Souls

```bash
# List all souls
openhinge soul list

# Create a soul
openhinge soul add -n "Translator" -s "You translate text between languages" --slug translator
openhinge soul add -n "Coder" -s "You are an expert programmer" -p <provider-id> -m claude-sonnet-4-6
openhinge soul add -n "Support Bot" -s "You help users with their questions" --slug support
```

**Soul add options:**

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Soul display name (required) |
| `-s, --system-prompt <prompt>` | System prompt / instructions (required) |
| `--slug <slug>` | URL slug for the endpoint (auto-generated from name if omitted) |
| `-p, --provider <id>` | Bind to a specific provider ID |
| `-m, --model <model>` | Model override |

### API Keys

```bash
# List all API keys
openhinge key list

# Create a key
openhinge key create -n "my-app"
openhinge key create -n "openclaw-key" -r 120
openhinge key create -n "translator-only" -s <soul-id>
openhinge key create -n "anthropic-key" -f anthropic
openhinge key create -n "openclaw-key" -f openclaw -r 120
```

**Key create options:**

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Key display name (required) |
| `-s, --soul <id>` | Bind to a specific soul ID |
| `-r, --rpm <n>` | Rate limit per minute (default: 60) |
| `-f, --format <format>` | API format: `openai` (default), `anthropic`, or `openclaw` |

> **Note:** The full API key is only shown once at creation. Save it immediately.

### OpenClaw Integration

```bash
# Auto-detect and configure OpenClaw to use OpenHinge
openhinge connect openclaw

# Specify a custom key name
openhinge connect openclaw --key-name "my-openclaw"

# Remove OpenHinge from OpenClaw config
openhinge connect openclaw --disconnect
```

### Updates & Maintenance

```bash
# Update to latest version (pulls, builds, migrates, restarts)
openhinge update

# Initialize config and database
openhinge init

# Run database migrations
openhinge migrate

# Enable start on boot
openhinge startup              # macOS: launchd, Linux: systemd
openhinge startup --disable    # Remove boot configuration

# Show version
openhinge --version

# Uninstall completely
openhinge uninstall
```

## API

OpenHinge supports both OpenAI and Anthropic API formats.

### Endpoints

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| POST | `/v1/chat/completions` | OpenAI | Chat completion |
| POST | `/v1/messages` | Anthropic | Messages API |
| POST | `/v1/souls/:slug/chat/completions` | OpenAI | Soul-specific chat |
| POST | `/v1/souls/:slug/messages` | Anthropic | Soul-specific messages |
| GET | `/v1/models` | OpenAI | List available models |
| GET | `/health` | — | Health check (no auth) |

### Authentication

```
Authorization: Bearer ohk_YOUR_KEY
```

Or for Anthropic format:

```
x-api-key: ohk_YOUR_KEY
```

### OpenAI Format (`/v1/chat/completions`)

**Supported parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Model ID |
| `messages` | array | Chat messages |
| `temperature` | number | Sampling temperature |
| `max_tokens` | number | Max tokens to generate |
| `max_completion_tokens` | number | Alias for max_tokens (OpenAI v2) |
| `stream` | boolean | Enable SSE streaming |
| `stop` | string[] | Stop sequences |
| `tools` | array | Function/tool definitions |
| `tool_choice` | string/object | Tool selection strategy |
| `top_p` | number | Nucleus sampling |
| `frequency_penalty` | number | Frequency penalty |
| `presence_penalty` | number | Presence penalty |
| `seed` | number | Deterministic sampling seed |
| `user` | string | End-user identifier |
| `response_format` | object | JSON schema output format |

### Anthropic Format (`/v1/messages`)

**Supported parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Model ID |
| `messages` | array | Messages with content blocks |
| `system` | string/array | System prompt |
| `max_tokens` | number | Max tokens (required) |
| `temperature` | number | Sampling temperature |
| `stream` | boolean | Enable SSE streaming |
| `stop_sequences` | string[] | Custom stop sequences |
| `tools` | array | Tool definitions (custom + server tools) |
| `tool_choice` | object | Tool selection strategy |
| `top_p` | number | Nucleus sampling |
| `top_k` | number | Top-K sampling |
| `thinking` | object | Extended thinking config |
| `metadata` | object | Request metadata |
| `service_tier` | string | Service tier selection |

**Content block types supported:**

- `text` — Text content
- `tool_use` — Tool call from assistant
- `tool_result` — Tool result from user
- `thinking` / `redacted_thinking` — Extended thinking blocks

### Soul Resolution

The soul for a request is determined by (in order):
1. URL path: `/v1/souls/:slug/chat/completions`
2. If the API key is bound to exactly one soul, auto-resolves
3. `X-OpenHinge-Soul` header with the soul slug

### Streaming

**OpenAI format:**

```bash
curl http://localhost:3700/v1/chat/completions \
  -H "Authorization: Bearer ohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

**Anthropic format:**

```bash
curl http://localhost:3700/v1/messages \
  -H "x-api-key: ohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

### Tool Calling

**OpenAI format:**

```bash
curl http://localhost:3700/v1/chat/completions \
  -H "Authorization: Bearer ohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "tools": [{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
    "messages": [{"role":"user","content":"Weather in Tokyo?"}]
  }'
```

**Anthropic format:**

```bash
curl http://localhost:3700/v1/messages \
  -H "x-api-key: ohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "tools": [{"name":"get_weather","description":"Get weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],
    "messages": [{"role":"user","content":"Weather in Tokyo?"}]
  }'
```

### SDK Examples

**Python (OpenAI SDK):**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3700/v1",
    api_key="ohk_YOUR_KEY"
)

response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello!"}],
    extra_headers={"X-OpenHinge-Soul": "translator"}
)
print(response.choices[0].message.content)
```

**Python (Anthropic SDK):**

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3700",
    api_key="ohk_YOUR_KEY"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

**Node.js (OpenAI SDK):**

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3700/v1',
  apiKey: 'ohk_YOUR_KEY',
});

const stream = await client.chat.completions.create({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

**Node.js (Anthropic SDK):**

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://localhost:3700',
  apiKey: 'ohk_YOUR_KEY',
});

const message = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(message.content[0].text);
```

## Architecture

```
Client Request
    │
    ├── Auth middleware (validate ohk_ key)
    ├── Rate limiter (sliding window, per key)
    ├── Budget check (daily/monthly limits)
    │
    ├── Soul resolver (system prompt + model)
    ├── Provider selector (priority + health + fallback)
    │
    ├── Provider adapter (Claude/OpenAI/Gemini/Ollama)
    │   └── Auto-refresh expired OAuth tokens (every 15 min)
    │
    ├── Stream/collect response
    └── Log usage (tokens, latency, cost)
```

**Stack:** Fastify, SQLite (better-sqlite3), TypeScript, vanilla JS dashboard.

## Cloudflare Tunnel

Expose your gateway to the internet over HTTPS:

1. Install cloudflared: `brew install cloudflared`
2. Authenticate: `cloudflared tunnel login`
3. Create a tunnel: `cloudflared tunnel create openhinge`
4. Configure in the dashboard **Cloudflare** page (auto-discovers zones and tunnels)
5. Add an ingress rule pointing your subdomain to `http://localhost:3700`
6. Run the tunnel: `cloudflared tunnel run`

## Deployment

### Using the CLI (recommended)

```bash
openhinge start              # Start in background
openhinge startup            # Enable start on boot
```

### macOS (LaunchAgent)

```bash
openhinge startup            # Creates and loads launchd plist automatically
openhinge startup --disable  # Remove
```

### Linux (systemd)

```bash
openhinge startup            # Creates and enables systemd user service automatically
openhinge startup --disable  # Remove
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENHINGE_PORT` | 3700 | Server port |
| `OPENHINGE_HOST` | 127.0.0.1 | Bind address |
| `OPENHINGE_ENCRYPTION_KEY` | (generated) | Encryption key for provider credentials |
| `OPENHINGE_DB_PATH` | ./data/openhinge.db | SQLite database path |
| `OPENHINGE_LOG_LEVEL` | info | Log level |

## License

MIT
