import type { FastifyInstance } from 'fastify';
import { execSync } from 'node:child_process';
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../utils/crypto.js';
import { generateId } from '../../utils/crypto.js';
import { loadProviders, getAllProviders, checkAllHealth } from '../../providers/index.js';
import { ClaudeProvider } from '../../providers/claude.js';
import { OpenAIProvider } from '../../providers/openai.js';
import { GeminiProvider } from '../../providers/gemini.js';
import { OllamaProvider } from '../../providers/ollama.js';
import type { Config } from '../../config/index.js';

export async function providerAdminRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.get('/admin/providers', async () => {
    const rows = getDb().prepare('SELECT id, name, type, base_url, config, priority, is_enabled, health_status, last_health_check, created_at FROM providers ORDER BY priority DESC').all();
    return { data: rows };
  });

  app.post<{ Body: any }>('/admin/providers', async (request, reply) => {
    const { name, type, base_url, provider_config, credentials, priority } = request.body as any;
    const id = generateId();

    const encryptedCreds = encrypt(JSON.stringify(credentials || {}), config.encryption.key);

    getDb().prepare(`
      INSERT INTO providers (id, name, type, base_url, config, credentials, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, type, base_url || null, JSON.stringify(provider_config || {}), encryptedCreds, priority || 0);

    loadProviders(config.encryption.key);

    reply.code(201).send({ id, name, type });
  });

  app.put<{ Params: { id: string }; Body: any }>('/admin/providers/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, base_url, provider_config, credentials, priority, is_enabled } = request.body as any;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (name !== undefined) { sets.push('name = ?'); values.push(name); }
    if (base_url !== undefined) { sets.push('base_url = ?'); values.push(base_url); }
    if (provider_config !== undefined) { sets.push('config = ?'); values.push(JSON.stringify(provider_config)); }
    if (credentials !== undefined) {
      sets.push('credentials = ?');
      values.push(encrypt(JSON.stringify(credentials), config.encryption.key));
    }
    if (priority !== undefined) { sets.push('priority = ?'); values.push(priority); }
    if (is_enabled !== undefined) { sets.push('is_enabled = ?'); values.push(is_enabled ? 1 : 0); }

    if (sets.length === 0) return reply.code(400).send({ error: 'Nothing to update' });

    sets.push("updated_at = datetime('now')");
    values.push(id);

    getDb().prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    loadProviders(config.encryption.key);

    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/admin/providers/:id', async (request) => {
    getDb().prepare('DELETE FROM providers WHERE id = ?').run(request.params.id);
    loadProviders(config.encryption.key);
    return { ok: true };
  });

  // Bulk actions on providers
  app.post<{ Body: any }>('/admin/providers/bulk', async (request, reply) => {
    const { action, ids } = request.body as any;
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids required' });

    const db = getDb();
    let affected = 0;

    switch (action) {
      case 'enable':
        for (const id of ids) { affected += db.prepare("UPDATE providers SET is_enabled = 1, updated_at = datetime('now') WHERE id = ?").run(id).changes; }
        break;
      case 'disable':
        for (const id of ids) { affected += db.prepare("UPDATE providers SET is_enabled = 0, updated_at = datetime('now') WHERE id = ?").run(id).changes; }
        break;
      case 'delete':
        for (const id of ids) { affected += db.prepare('DELETE FROM providers WHERE id = ?').run(id).changes; }
        break;
      case 'health':
        // Just trigger a health check reload — the actual check happens via the existing endpoint
        break;
      default:
        return reply.code(400).send({ error: `Unknown action: ${action}` });
    }

    loadProviders(config.encryption.key);
    return { ok: true, affected };
  });

  // Probe a provider config (without saving) and return available models
  app.post<{ Body: any }>('/admin/providers/probe', async (request, reply) => {
    const { type, base_url, api_key } = request.body as any;

    const providerConfig = {
      id: 'probe',
      name: 'probe',
      type,
      base_url: base_url || undefined,
      config: {},
      credentials: {} as Record<string, string>,
      priority: 0,
      is_enabled: true,
    };

    if (api_key) {
      const credKey = api_key.startsWith('sk-ant-oat01-') ? 'oauth_token' : 'api_key';
      providerConfig.credentials[credKey] = api_key;
    }

    let provider;
    switch (type) {
      case 'claude': provider = new ClaudeProvider(providerConfig); break;
      case 'openai': provider = new OpenAIProvider(providerConfig); break;
      case 'gemini': provider = new GeminiProvider(providerConfig); break;
      case 'ollama': provider = new OllamaProvider(providerConfig); break;
      default: return reply.code(400).send({ error: `Unknown type: ${type}` });
    }

    try {
      const [models, health] = await Promise.all([
        provider.listModels(),
        provider.healthCheck(),
      ]);
      return { models, health };
    } catch (err: any) {
      return { models: [], health: { status: 'down', latency_ms: 0, message: err.message } };
    }
  });

  app.post('/admin/providers/health', async () => {
    const results = await checkAllHealth(config.encryption.key);
    const data: any[] = [];
    for (const [id, health] of results) {
      data.push({ id, ...health });
    }
    return { data };
  });

  // Helper: scan shell config files for an exported env var value
  function scanShellForKey(varName: string): string | null {
    const home = homedir();
    const files = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.env'];
    for (const f of files) {
      try {
        const content = readFileSync(join(home, f), 'utf-8');
        // Match: export VAR="value" or export VAR='value' or export VAR=value
        const match = content.match(new RegExp(`export\\s+${varName}\\s*=\\s*["']?([^"'\\s#]+)["']?`));
        if (match?.[1]) return match[1];
      } catch { /* file not found */ }
    }
    return null;
  }

  // Auto-detect available providers on this machine
  app.get('/admin/providers/detect', async () => {
    const detected: any[] = [];

    // 1. Claude — read OAuth token from macOS keychain (subscription auth)
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      const data = JSON.parse(raw);
      const oauth = data.claudeAiOauth;
      if (oauth?.accessToken) {
        detected.push({
          type: 'claude',
          name: 'Claude (Subscription)',
          source: 'macOS Keychain — Claude Code OAuth',
          token_preview: oauth.accessToken.slice(0, 20) + '...',
          token: oauth.accessToken,
          subscription: oauth.subscriptionType || 'unknown',
          expires_at: oauth.expiresAt,
          auth_method: 'oauth',
          auto: true,
        });
      }
    } catch { /* Claude Code not installed or no token */ }

    // 1b. Claude — check for ANTHROPIC_API_KEY in env or shell configs
    if (!detected.some(d => d.type === 'claude')) {
      const anthropicKey = process.env.ANTHROPIC_API_KEY || scanShellForKey('ANTHROPIC_API_KEY');
      if (anthropicKey) {
        detected.push({
          type: 'claude',
          name: 'Claude (API Key)',
          source: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY env var' : 'Shell config file',
          token_preview: anthropicKey.slice(0, 15) + '...',
          token: anthropicKey,
          auth_method: 'api_key',
          auto: true,
        });
      }
    }

    // 2. Ollama — check if running locally
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as any;
        const models = (data.models || []).map((m: any) => m.name);
        detected.push({
          type: 'ollama',
          name: 'Ollama (Local)',
          source: 'localhost:11434',
          models,
          auth_method: 'none',
          auto: true,
        });
      }
    } catch { /* Ollama not running */ }

    // 3. OpenAI — check env var, then shell config files
    const openaiKey = process.env.OPENAI_API_KEY || scanShellForKey('OPENAI_API_KEY');
    if (openaiKey) {
      detected.push({
        type: 'openai',
        name: 'OpenAI',
        source: process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY env var' : 'Shell config file',
        token_preview: openaiKey.slice(0, 10) + '...',
        token: openaiKey,
        auth_method: 'api_key',
        auto: true,
      });
    }

    // 4. Gemini — check env var, then shell configs, then gcloud ADC
    let geminiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY
      || scanShellForKey('GOOGLE_API_KEY') || scanShellForKey('GEMINI_API_KEY');
    let geminiSource = 'Environment / Shell config';

    if (!geminiKey) {
      // Try Google Cloud Application Default Credentials
      try {
        const adcPath = join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
        const adc = JSON.parse(readFileSync(adcPath, 'utf-8'));
        if (adc.client_secret || adc.api_key) {
          geminiKey = adc.api_key || adc.client_secret;
          geminiSource = 'Google Cloud ADC (~/.config/gcloud)';
        }
      } catch { /* no gcloud */ }
    }

    if (geminiKey) {
      detected.push({
        type: 'gemini',
        name: 'Gemini',
        source: geminiSource,
        token_preview: geminiKey.slice(0, 10) + '...',
        token: geminiKey,
        auth_method: 'api_key',
        auto: true,
      });
    }

    return { data: detected };
  });

  // Quick-add: auto-create a provider from detected credentials
  app.post<{ Body: { type: string; token?: string; name?: string; priority?: number } }>('/admin/providers/quick-add', async (request, reply) => {
    const { type, token, name, priority } = request.body;
    const id = generateId();

    let credentials: Record<string, string> = {};
    let providerName = name || type;
    let baseUrl: string | null = null;
    let providerConfig: Record<string, unknown> = {};

    if (type === 'claude') {
      const apiKey = token || '';
      if (!apiKey) {
        // Try reading from keychain
        try {
          const raw = execSync(
            'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
            { encoding: 'utf-8', timeout: 5000 }
          ).trim();
          const data = JSON.parse(raw);
          const oauth = data.claudeAiOauth;
          if (oauth?.accessToken) {
            credentials = { oauth_token: oauth.accessToken };
            providerName = name || 'Claude (Subscription)';
          }
        } catch {
          return reply.code(400).send({ error: 'Could not read Claude token from keychain' });
        }
      } else {
        const credKey = apiKey.startsWith('sk-ant-oat01-') ? 'oauth_token' : 'api_key';
        credentials = { [credKey]: apiKey };
        providerName = name || (apiKey.startsWith('sk-ant-oat01-') ? 'Claude (Subscription)' : 'Claude (API)');
      }
    } else if (type === 'ollama') {
      providerName = name || 'Ollama (Local)';
      baseUrl = 'http://127.0.0.1:11434';
    } else if (type === 'openai') {
      if (!token) return reply.code(400).send({ error: 'API key required' });
      credentials = { api_key: token };
      providerName = name || 'OpenAI';
    } else if (type === 'gemini') {
      if (!token) return reply.code(400).send({ error: 'API key required' });
      credentials = { api_key: token };
      providerName = name || 'Gemini';
    } else {
      return reply.code(400).send({ error: `Unknown type: ${type}` });
    }

    // Probe to get default model
    const tempConfig = {
      id: 'probe', name: 'probe', type,
      base_url: baseUrl || undefined,
      config: {}, credentials, priority: 0, is_enabled: true,
    };
    let defaultModel = '';
    try {
      let provider;
      switch (type) {
        case 'claude': provider = new ClaudeProvider(tempConfig); break;
        case 'openai': provider = new OpenAIProvider(tempConfig); break;
        case 'gemini': provider = new GeminiProvider(tempConfig); break;
        case 'ollama': provider = new OllamaProvider(tempConfig); break;
      }
      if (provider) {
        const models = await provider.listModels();
        if (models.length > 0) defaultModel = models[0];
      }
    } catch { /* ignore */ }

    if (defaultModel) providerConfig.default_model = defaultModel;

    const encryptedCreds = encrypt(JSON.stringify(credentials), config.encryption.key);

    getDb().prepare(`
      INSERT INTO providers (id, name, type, base_url, config, credentials, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, providerName, type, baseUrl, JSON.stringify(providerConfig), encryptedCreds, priority || 50);

    loadProviders(config.encryption.key);

    reply.code(201).send({ id, name: providerName, type, model: defaultModel });
  });

  // Open URL in browser (for manual API key pages)
  app.post<{ Body: { url: string } }>('/admin/providers/open-browser', async (request) => {
    const { url } = request.body;
    const allowedUrls = [
      'https://console.anthropic.com',
      'https://platform.openai.com',
      'https://aistudio.google.com',
      'https://claude.ai',
    ];
    if (!allowedUrls.some(u => url.startsWith(u))) {
      return { error: 'URL not allowed' };
    }
    exec(`open "${url}"`);
    return { ok: true };
  });

  // ===== OAuth Login Flow =====
  // Real OAuth: opens provider login page in browser, captures token via redirect callback
  let authServer: Server | null = null;
  let authResult: { status: string; provider?: any; error?: string } | null = null;

  // PKCE helpers
  function generateCodeVerifier(): string {
    return randomBytes(32).toString('base64url');
  }
  function generateCodeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  // OAuth configs per provider
  const oauthConfigs: Record<string, {
    name: string;
    clientId: string;
    clientSecret?: string;
    authUrl: string;
    tokenUrl: string;
    redirectUri: string;
    port: number;
    callbackPath: string;
    scopes: string;
    providerType: string;
    extraParams?: Record<string, string>;
  }> = {
    claude: {
      name: 'Claude (Subscription)',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      authUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      redirectUri: 'https://console.anthropic.com/oauth/code/callback',
      port: 0, // not used — redirect goes to Anthropic, we handle differently
      callbackPath: '/oauth/callback',
      scopes: 'org:create_api_key user:profile user:inference',
      providerType: 'claude',
    },
    openai: {
      name: 'OpenAI (ChatGPT)',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      authUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      redirectUri: 'http://localhost:1455/auth/callback',
      port: 1455,
      callbackPath: '/auth/callback',
      scopes: 'openid profile email offline_access',
      providerType: 'openai',
      extraParams: {
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'openhinge',
      },
    },
    gemini: {
      name: 'Google Gemini',
      clientId: process.env.GEMINI_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GEMINI_OAUTH_CLIENT_SECRET || '',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      redirectUri: 'http://localhost:8085/oauth2callback',
      port: 8085,
      callbackPath: '/oauth2callback',
      scopes: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      providerType: 'gemini',
    },
  };

  // Helper: create provider from token (extraCreds for refresh_token, client_id, etc.)
  async function createProviderFromToken(
    type: string, token: string, provName: string, credKey: string = 'api_key',
    extraCreds: Record<string, string> = {}
  ) {
    const id = generateId();
    const credentials = { [credKey]: token, ...extraCreds };
    const encCreds = encrypt(JSON.stringify(credentials), config.encryption.key);

    let defaultModel = '';
    try {
      let provider;
      const tempCfg = { id: 'probe', name: 'probe', type, config: {}, credentials, priority: 0, is_enabled: true };
      switch (type) {
        case 'claude': provider = new ClaudeProvider(tempCfg); break;
        case 'openai': provider = new OpenAIProvider(tempCfg); break;
        case 'gemini': provider = new GeminiProvider(tempCfg); break;
        case 'ollama': provider = new OllamaProvider({ ...tempCfg, base_url: 'http://127.0.0.1:11434' }); break;
      }
      if (provider) {
        const models = await provider.listModels();
        if (models.length > 0) defaultModel = models[0];
      }
    } catch { /* ignore */ }

    const providerConfig = defaultModel ? JSON.stringify({ default_model: defaultModel }) : '{}';
    const baseUrl = type === 'ollama' ? 'http://127.0.0.1:11434' : null;

    getDb().prepare(`
      INSERT INTO providers (id, name, type, base_url, config, credentials, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, provName, type, baseUrl, providerConfig, encCreds, 50);

    loadProviders(config.encryption.key);
    return { id, name: provName, type, model: defaultModel };
  }

  // Start OAuth login
  app.post<{ Body: { type: string } }>('/admin/providers/auth/start', async (request, reply) => {
    const { type } = request.body;
    authResult = null;

    // === Claude: try keychain first (already authenticated via Claude Code) ===
    if (type === 'claude') {
      try {
        const raw = execSync(
          'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        const data = JSON.parse(raw);
        const oauth = data.claudeAiOauth;
        if (oauth?.accessToken) {
          const provider = await createProviderFromToken('claude', oauth.accessToken, 'Claude (Subscription)', 'oauth_token');
          authResult = { status: 'complete', provider };
          return {
            status: 'complete',
            provider,
            method: 'keychain_oauth',
            subscription: oauth.subscriptionType || 'unknown',
          };
        }
      } catch { /* fall through to OAuth */ }
    }

    // === OpenAI: try Codex auth file first (like Claude keychain) ===
    if (type === 'openai') {
      try {
        const codexAuthPath = join(homedir(), '.codex', 'auth.json');
        const codexAuth = JSON.parse(readFileSync(codexAuthPath, 'utf-8'));
        if (codexAuth.tokens?.access_token && codexAuth.auth_mode === 'chatgpt') {
          const extraCreds: Record<string, string> = {};
          if (codexAuth.tokens.refresh_token) extraCreds.refresh_token = codexAuth.tokens.refresh_token;
          if (codexAuth.tokens.account_id) extraCreds.account_id = codexAuth.tokens.account_id;
          extraCreds.client_id = 'app_EMoamEEZ73f0CkXaXp7hrann';

          const provider = await createProviderFromToken(
            'openai', codexAuth.tokens.access_token,
            'OpenAI (ChatGPT)', 'oauth_token', extraCreds
          );
          authResult = { status: 'complete', provider };
          return {
            status: 'complete', provider,
            method: 'codex_auth',
            plan: codexAuth.tokens.id_token ? 'chatgpt' : 'unknown',
          };
        }
      } catch { /* no codex auth, fall through to OAuth */ }
    }

    // === Ollama: local detect ===
    if (type === 'ollama') {
      try {
        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const provider = await createProviderFromToken('ollama', '', 'Ollama (Local)');
          authResult = { status: 'complete', provider };
          return { status: 'complete', provider, method: 'local_detect' };
        }
      } catch { /* not running */ }
      return reply.code(400).send({ error: 'Ollama not running on localhost:11434' });
    }

    // === OAuth flow for OpenAI, Gemini, Claude (fallback) ===
    const oauthCfg = oauthConfigs[type];
    if (!oauthCfg) return reply.code(400).send({ error: `Unknown provider type: ${type}` });

    // Kill existing auth server
    if (authServer) {
      try { authServer.close(); } catch { /* ignore */ }
      authServer = null;
    }

    const state = randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Build authorization URL
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: oauthCfg.clientId,
      redirect_uri: oauthCfg.redirectUri,
      scope: oauthCfg.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    // Google needs access_type=offline for refresh token
    if (type === 'gemini') {
      authParams.set('access_type', 'offline');
      authParams.set('prompt', 'consent');
    }

    // Append provider-specific extra params (e.g. OpenAI's codex_cli_simplified_flow)
    if (oauthCfg.extraParams) {
      for (const [k, v] of Object.entries(oauthCfg.extraParams)) {
        authParams.set(k, v);
      }
    }

    const authorizationUrl = `${oauthCfg.authUrl}?${authParams.toString()}`;

    // Success page HTML
    const successHtml = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>OpenHinge — Connected!</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:40px;text-align:center;max-width:400px}
h1{font-size:20px;margin:12px 0 4px}p{color:#888;font-size:14px}</style>
</head><body><div class="card">
<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
<h1>Connected!</h1><p>You can close this tab and return to OpenHinge.</p>
</div></body></html>`;

    // Start local callback server
    authServer = createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost:${oauthCfg.port}`);

      if (reqUrl.pathname === oauthCfg.callbackPath && req.method === 'GET') {
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        if (error) {
          const desc = reqUrl.searchParams.get('error_description') || error;
          authResult = { status: 'error', error: desc };
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="background:#0f0f0f;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div><h1>Auth Error</h1><p style="color:#f44">${desc}</p></div></body></html>`);
          return;
        }

        if (!code || returnedState !== state) {
          authResult = { status: 'error', error: 'State mismatch or missing code' };
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body style="background:#0f0f0f;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h1>Auth failed — state mismatch or missing code</h1></body></html>');
          return;
        }

        // Exchange code for tokens (handle async properly)
        (async () => {
          const tokenParams: Record<string, string> = {
            grant_type: 'authorization_code',
            code,
            redirect_uri: oauthCfg.redirectUri,
            client_id: oauthCfg.clientId,
            code_verifier: codeVerifier,
          };
          if (oauthCfg.clientSecret) {
            tokenParams.client_secret = oauthCfg.clientSecret;
          }

          const tokenRes = await fetch(oauthCfg.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(tokenParams).toString(),
          });

          const tokenData = await tokenRes.json() as any;

          if (!tokenRes.ok || tokenData.error) {
            throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');
          }

          const accessToken = tokenData.access_token;
          let tokenToStore = accessToken;

          // Gemini OAuth: discover projectId via Cloud Code Assist API
          if (oauthCfg.providerType === 'gemini') {
            const ccHeaders = {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
              'X-Goog-Api-Client': 'gl-node/22.17.0',
            };

            const metadata = {
              ideType: 'GEMINI_CLI',
              pluginType: 'GEMINI',
              platform: 'PLATFORM_UNSPECIFIED',
            };

            // Try loadCodeAssist to get existing project
            let projectId = '';
            try {
              const lcRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
                method: 'POST',
                headers: ccHeaders,
                body: JSON.stringify({ metadata }),
              });
              const lcData = await lcRes.json() as any;
              console.log('loadCodeAssist status:', lcRes.status, 'response:', JSON.stringify(lcData));
              if (lcRes.ok) {
                const proj = lcData.cloudaicompanionProject;
                projectId = typeof proj === 'string' ? proj : proj?.id || '';
              }
            } catch (e: any) {
              console.error('loadCodeAssist error:', e.message);
            }

            // If no project, onboard user to provision one (free tier)
            if (!projectId) {
              try {
                const obRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:onboardUser', {
                  method: 'POST',
                  headers: ccHeaders,
                  body: JSON.stringify({ tierId: 'free-tier', metadata }),
                });
                const obData = await obRes.json() as any;
                console.log('onboardUser status:', obRes.status, 'response:', JSON.stringify(obData));
                if (obRes.ok) {
                  // onboardUser returns a long-running operation — poll if not done
                  if (obData.done && obData.response?.cloudaicompanionProject) {
                    const proj = obData.response.cloudaicompanionProject;
                    projectId = typeof proj === 'string' ? proj : proj?.id || '';
                  } else if (obData.name && !obData.done) {
                    // Poll the operation
                    for (let i = 0; i < 10 && !projectId; i++) {
                      await new Promise(r => setTimeout(r, 5000));
                      const pollRes = await fetch(`https://cloudcode-pa.googleapis.com/v1internal/${obData.name}`, {
                        headers: ccHeaders,
                      });
                      if (pollRes.ok) {
                        const pollData = await pollRes.json() as any;
                        console.log(`onboardUser poll ${i}:`, JSON.stringify(pollData));
                        if (pollData.done && pollData.response?.cloudaicompanionProject) {
                          const proj = pollData.response.cloudaicompanionProject;
                          projectId = typeof proj === 'string' ? proj : proj?.id || '';
                        }
                      }
                    }
                  }
                }
              } catch (e: any) {
                console.error('onboardUser error:', e.message);
              }
            }

            // Fallback: search Cloud Resource Manager for gen-lang-client-* projects
            if (!projectId) {
              try {
                const crmRes = await fetch(
                  'https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE&pageSize=100',
                  { headers: { 'Authorization': `Bearer ${accessToken}` } },
                );
                if (crmRes.ok) {
                  const crmData = await crmRes.json() as any;
                  console.log('CRM projects found:', (crmData.projects || []).length);
                  const genLangProject = (crmData.projects || []).find(
                    (p: any) => p.projectId?.startsWith('gen-lang-client-')
                  );
                  if (genLangProject) {
                    projectId = genLangProject.projectId;
                    console.log('Found gen-lang-client project:', projectId);
                  }
                }
              } catch (e: any) {
                console.error('CRM fallback error:', e.message);
              }
            }

            if (!projectId) {
              throw new Error('Could not discover Gemini project ID — try again or use an API key instead');
            }

            // Store as JSON with token + projectId
            tokenToStore = JSON.stringify({ token: accessToken, projectId });
            console.log(`Gemini OAuth: discovered projectId=${projectId}`);
          }

          // Build extra credentials for token refresh
          const extraCreds: Record<string, string> = {};
          if (tokenData.refresh_token) extraCreds.refresh_token = tokenData.refresh_token;
          if (oauthCfg.clientId) extraCreds.client_id = oauthCfg.clientId;
          if (oauthCfg.clientSecret) extraCreds.client_secret = oauthCfg.clientSecret;
          if (tokenData.expires_in) {
            extraCreds.expires_at = String(Date.now() + tokenData.expires_in * 1000);
          }

          const provider = await createProviderFromToken(
            oauthCfg.providerType,
            tokenToStore,
            oauthCfg.name,
            'oauth_token',
            extraCreds
          );

          authResult = { status: 'complete', provider };

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(successHtml);

          setTimeout(() => {
            if (authServer) { authServer.close(); authServer = null; }
          }, 2000);
        })().catch((err: any) => {
          console.error('OAuth token exchange error:', err);
          authResult = { status: 'error', error: err.message };
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="background:#0f0f0f;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div><h1>Auth Error</h1><p style="color:#f44">${err.message}</p></div></body></html>`);
        });
        return;
      }

      // Keep-alive endpoint so we can verify server is running
      if (reqUrl.pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    authServer.on('error', (err) => {
      console.error('Auth server error:', err);
      authResult = { status: 'error', error: `Auth server failed: ${err.message}` };
    });

    await new Promise<void>((resolve, reject) => {
      authServer!.listen(oauthCfg.port, '127.0.0.1', () => {
        console.log(`OAuth callback server listening on port ${oauthCfg.port}`);
        resolve();
      });
      authServer!.on('error', reject);
    });

    // Open browser to provider's login page
    exec(`open "${authorizationUrl}"`);

    // Auto-timeout after 5 min
    setTimeout(() => {
      if (authServer) { authServer.close(); authServer = null; }
      if (!authResult) authResult = { status: 'error', error: 'Auth timed out' };
    }, 300000);

    return {
      status: 'auth_started',
      auth_url: authorizationUrl,
      provider_type: type,
      message: `Browser opened — log in to ${oauthCfg.name} to connect`,
    };
  });

  // Poll auth status from dashboard
  app.get('/admin/providers/auth/status', async () => {
    if (authResult) {
      const result = { ...authResult };
      if (result.status === 'complete') authResult = null; // consume
      return result;
    }
    if (authServer) return { status: 'waiting' };
    return { status: 'idle' };
  });

  app.post('/admin/providers/auth/cancel', async () => {
    if (authServer) {
      authServer.close();
      authServer = null;
    }
    authResult = null;
    return { ok: true };
  });
}
