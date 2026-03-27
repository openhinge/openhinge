# OpenHinge

Self-hosted AI gateway that unifies multiple LLM providers behind a single OpenAI-compatible API.

Use your own subscriptions (Claude Pro, ChatGPT Plus, Gemini) and API keys. Control access with API keys, rate limits, and budget controls. Route requests through AI personas ("souls") with dedicated system prompts and endpoints.

## Features

- **Multi-provider** — Claude, OpenAI, Gemini, Ollama. Multiple accounts of the same type supported.
- **OAuth login** — Use your existing subscriptions. Click "Login with Claude/OpenAI/Gemini" to authenticate via browser. Tokens auto-refresh when they expire.
- **Souls** — AI personas with system prompts, dedicated endpoints, and configurable models/temperature.
- **OpenAI-compatible API** — Drop-in replacement. Works with any OpenAI SDK (Python, Node.js, etc).
- **Streaming** — Full SSE streaming support, OpenAI format.
- **API key management** — `ohk_` prefixed keys with rate limits, soul binding, budget controls, and expiry.
- **Request logging** — Every request logged with tokens, latency, cost. Searchable, filterable, paginated.
- **Dashboard** — Web UI for managing providers, souls, keys, logs, and settings.
- **Fallback routing** — Providers have priority. If one fails, the next healthy provider handles the request.
- **Health monitoring** — Per-provider health checks that don't consume generation quota.
- **Cloudflare Tunnel** — Expose your gateway over HTTPS without opening ports.
- **CLI** — Full command-line interface for setup and management.
- **Zero external dependencies** — Embedded SQLite, no Redis/Postgres/Docker required.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/openhinge/openhinge/main/install.sh | bash
cd ~/openhinge
npm start
```

Or manually:

```bash
git clone https://github.com/openhinge/openhinge.git
cd openhinge
npm install
npm run build
npm start
```

On first run, OpenHinge auto-generates your config and prints your admin token to the terminal. Open `http://localhost:3700` and paste the token to get started.

## Setup

### 1. Add a Provider

Go to **Providers → Add Provider**. Choose your provider and authenticate:

| Provider | OAuth (Subscription) | API Key |
|----------|---------------------|---------|
| **Claude** | Auto-detects from Claude Code keychain | `sk-ant-api03-...` from console.anthropic.com |
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

## API

OpenHinge is fully OpenAI-compatible. Point any OpenAI SDK at your gateway.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat completion (specify model or use soul header) |
| POST | `/v1/souls/:slug/chat/completions` | Soul-specific chat (system prompt auto-prepended) |
| GET | `/v1/models` | List available models across all providers |
| GET | `/health` | Health check (no auth required) |

### Authentication

```
Authorization: Bearer ohk_YOUR_KEY
```

### Soul Resolution

The soul for a request is determined by (in order):
1. URL path: `/v1/souls/:slug/chat/completions`
2. If the API key is bound to exactly one soul, auto-resolves
3. `X-OpenHinge-Soul` header with the soul slug

### Streaming

Set `"stream": true` for Server-Sent Events:

```bash
curl http://localhost:3700/v1/souls/translator/chat/completions \
  -H "Authorization: Bearer ohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

### SDK Examples

**Python:**
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

**Node.js:**
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
}, {
  headers: { 'X-OpenHinge-Soul': 'translator' },
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
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
    │   └── Auto-refresh expired OAuth tokens
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

## CLI

```bash
npx tsx bin/openhinge.ts <command>
```

| Command | Description |
|---------|-------------|
| `init` | Generate config, admin token, encryption key, run migrations |
| `migrate` | Run pending database migrations |
| `status` | Show providers, souls, keys, request counts |
| `provider list` | List configured providers |
| `provider add` | Add a provider interactively |
| `provider health` | Run health checks |
| `soul list` | List souls |
| `soul add` | Create a soul |
| `key list` | List API keys |
| `key create` | Generate a new key |

## Deployment

### macOS (LaunchAgent)

```bash
# Edit deploy/com.openhinge.gateway.plist to match your paths
cp deploy/com.openhinge.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openhinge.gateway.plist
```

### Linux (systemd)

```ini
[Unit]
Description=OpenHinge AI Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/openhinge
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENHINGE_PORT` | 3700 | Server port |
| `OPENHINGE_HOST` | 127.0.0.1 | Bind address |
| `OPENHINGE_ADMIN_TOKEN` | (generated) | Dashboard admin token |
| `OPENHINGE_ENCRYPTION_KEY` | (generated) | Encryption key for provider credentials |
| `OPENHINGE_DB_PATH` | ./data/openhinge.db | SQLite database path |
| `OPENHINGE_LOG_LEVEL` | info | Log level |

## License

MIT
