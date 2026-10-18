import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

process.env.OPENHINGE_LOG_LEVEL = 'silent';

const ENCRYPTION_KEY = 'a'.repeat(64);

// Stand-in for an Ollama server: echoes the request back so tests can see what reached it
let ollama: Server;
let ollamaUrl = '';
let lastOllamaBody: any = null;

function startMockOllama(): Promise<void> {
  ollama = createHttpServer((req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'mock-small' }, { name: 'mock-large' }] }));
      return;
    }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      lastOllamaBody = body;
      if (body.model === 'missing-model') {
        res.statusCode = 404;
        res.end('model "missing-model" not found');
        return;
      }
      const lastUser = body.messages.filter((m: any) => m.role === 'user').pop()?.content;
      if (body.stream) {
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(JSON.stringify({ message: { content: 'Hel' } }) + '\n');
        res.write(JSON.stringify({ message: { content: 'lo' } }) + '\n');
        res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 2 }) + '\n');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: body.model,
        message: { content: `echo: ${lastUser}` },
        done_reason: 'stop',
        prompt_eval_count: 7,
        eval_count: 3,
      }));
    });
  });
  return new Promise(resolve => ollama.listen(0, '127.0.0.1', () => {
    ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
    resolve();
  }));
}

let app: FastifyInstance;
let auth: Record<string, string>;
let dataDir: string;
let soulId: string;
let fallbackSoulId: string;
let db: any;
let providerChainFor: (soul: any) => string[];
let stopBackgroundRefresh: () => void;
let closeDatabase: () => void;

beforeAll(async () => {
  await startMockOllama();
  dataDir = mkdtempSync(join(tmpdir(), 'openhinge-playground-'));

  const { configSchema } = await import('../src/config/schema.js');
  const { createServer } = await import('../src/server.js');
  const { getDb } = await import('../src/db/index.js');
  const providers = await import('../src/providers/index.js');
  const { createSession } = await import('../src/auth/sessions.js');
  const { createSoul } = await import('../src/souls/repository.js');
  ({ closeDatabase } = await import('../src/db/index.js'));
  providerChainFor = providers.providerChainFor;
  stopBackgroundRefresh = providers.stopBackgroundRefresh;

  app = await createServer(configSchema.parse({
    db: { path: join(dataDir, 'test.db') },
    auth: { passwordHash: 'set' },
    encryption: { key: ENCRYPTION_KEY },
  }));

  // "Dead" has the higher priority, so it is the gateway default
  db = getDb();
  const insert = db.prepare('INSERT INTO providers (id, name, type, base_url, config, credentials, priority) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('p-local', 'Local', 'ollama', ollamaUrl, JSON.stringify({ default_model: 'mock-small' }), '{}', 10);
  insert.run('p-dead', 'Dead', 'ollama', 'http://127.0.0.1:1', '{}', '{}', 20);
  await providers.loadProviders(ENCRYPTION_KEY);

  soulId = createSoul({
    name: 'Tester', system_prompt: 'You are a test soul.', provider_id: 'p-local', model: 'mock-large', temperature: 0.2,
  }).id;
  fallbackSoulId = createSoul({
    name: 'Fallback', system_prompt: 'x', provider_id: 'p-dead', fallback_chain: ['p-local'],
  }).id;

  auth = { authorization: `Bearer ${createSession()}` };
});

afterAll(async () => {
  await app?.close();
  stopBackgroundRefresh?.();
  closeDatabase?.();
  ollama?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => { lastOllamaBody = null; });

function chat(body: Record<string, unknown>, headers = auth) {
  return app.inject({ method: 'POST', url: '/admin/playground/chat', headers, payload: body });
}

const hello = [{ role: 'user', content: 'hello' }];

function sseEvents(payload: string): any[] {
  return payload.split('\n\n').filter(e => e.startsWith('data: ')).map(e => JSON.parse(e.slice(6)));
}

function lastLog() {
  return db.prepare('SELECT * FROM usage_logs ORDER BY id DESC LIMIT 1').get();
}

describe('providerChainFor', () => {
  it('puts the soul provider and its fallbacks before the top-priority provider', () => {
    expect(providerChainFor({ provider_id: 'p-local', fallback_chain: ['x'] })).toEqual(['p-local', 'x', 'p-dead']);
  });

  it('does not repeat the top-priority provider', () => {
    expect(providerChainFor({ provider_id: 'p-dead', fallback_chain: [] })).toEqual(['p-dead']);
  });

  it('is just the top-priority provider without a soul', () => {
    expect(providerChainFor(null)).toEqual(['p-dead']);
  });
});

describe('GET /admin/playground/models', () => {
  it('needs a dashboard session', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/playground/models?provider_id=p-local' });
    expect(res.statusCode).toBe(401);
  });

  it("lists the provider's models and its default", async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/playground/models?provider_id=p-local', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ default_model: 'mock-small', models: ['mock-small', 'mock-large'] });
  });

  it('404s for an unknown provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/playground/models?provider_id=nope', headers: auth });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /admin/playground/chat', () => {
  it('needs a dashboard session', async () => {
    const res = await chat({ messages: hello }, {});
    expect(res.statusCode).toBe(401);
  });

  it('sends to the chosen provider with the given model, system prompt and temperature', async () => {
    const res = await chat({ provider_id: 'p-local', model: 'mock-large', system: 'Be brief.', temperature: 0.5, messages: hello });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('echo: hello');
    expect(body.provider).toEqual({ id: 'p-local', name: 'Local' });
    expect(body.model).toBe('mock-large');
    expect(body.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
    expect(body.fallback_attempts).toEqual([]);
    expect(typeof body.latency_ms).toBe('number');

    expect(lastOllamaBody.messages).toEqual([{ role: 'system', content: 'Be brief.' }, ...hello]);
    expect(lastOllamaBody.options.temperature).toBe(0.5);
  });

  it('uses the provider default model when none is given', async () => {
    await chat({ provider_id: 'p-local', messages: hello });
    expect(lastOllamaBody.model).toBe('mock-small');
    expect(lastOllamaBody.messages).toEqual(hello);
  });

  it('does not fall back when a provider is chosen', async () => {
    const res = await chat({ provider_id: 'p-dead', messages: hello });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('Dead');
    expect(lastOllamaBody).toBeNull();
  });

  it('shows the provider error for a model it does not have', async () => {
    const res = await chat({ provider_id: 'p-local', model: 'missing-model', messages: hello });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('model "missing-model" not found');
  });

  it('routes the gateway default like /v1/chat/completions: top-priority provider only', async () => {
    const res = await chat({ messages: hello });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('Dead');
    expect(lastOllamaBody).toBeNull();
  });

  it("follows a soul's fallback chain and reports the providers it skipped", async () => {
    const res = await chat({ soul_id: fallbackSoulId, messages: hello });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider.id).toBe('p-local');
    expect(body.fallback_attempts).toHaveLength(1);
    expect(body.fallback_attempts[0]).toMatchObject({ provider_id: 'p-dead', provider_name: 'Dead' });
  });

  it("uses a soul's system prompt, model and temperature", async () => {
    const res = await chat({ soul_id: soulId, messages: hello });
    expect(res.statusCode).toBe(200);
    expect(lastOllamaBody.model).toBe('mock-large');
    expect(lastOllamaBody.options.temperature).toBe(0.2);
    expect(lastOllamaBody.messages[0]).toEqual({ role: 'system', content: 'You are a test soul.' });
  });

  it("lets the request replace or drop a soul's system prompt", async () => {
    await chat({ soul_id: soulId, system: 'Different.', messages: hello });
    expect(lastOllamaBody.messages[0]).toEqual({ role: 'system', content: 'Different.' });
    await chat({ soul_id: soulId, system: '', messages: hello });
    expect(lastOllamaBody.messages).toEqual(hello);
  });

  it('logs requests under the playground key', async () => {
    await chat({ soul_id: soulId, messages: hello });
    expect(lastLog()).toMatchObject({ api_key_id: 'playground', soul_id: soulId, provider_id: 'p-local', status: 'success', output_tokens: 3 });

    await chat({ provider_id: 'p-dead', messages: hello });
    expect(lastLog()).toMatchObject({ api_key_id: 'playground', provider_id: 'none', status: 'error' });
  });

  it.each([
    ['no messages', { messages: [] }, 400],
    ['a bad role', { messages: [{ role: 'robot', content: 'hi' }] }, 400],
    ['non-string content', { messages: [{ role: 'user', content: 42 }] }, 400],
    ['both a provider and a soul', { provider_id: 'p-local', soul_id: 'x', messages: hello }, 400],
    ['a non-numeric temperature', { temperature: 'hot', messages: hello }, 400],
    ['a zero max_tokens', { max_tokens: 0, messages: hello }, 400],
    ['an unknown provider', { provider_id: 'nope', messages: hello }, 404],
    ['an unknown soul', { soul_id: 'nope', messages: hello }, 404],
  ])('rejects %s', async (_name, body, status) => {
    const res = await chat(body);
    expect(res.statusCode).toBe(status);
    expect(lastOllamaBody).toBeNull();
  });

  it('streams deltas, then one done event with timing and usage', async () => {
    const res = await chat({ provider_id: 'p-local', stream: true, messages: hello });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const events = sseEvents(res.payload);
    expect(events.filter(e => e.type === 'delta').map(e => e.text)).toEqual(['Hel', 'lo']);
    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: 'done', provider: { id: 'p-local' }, model: 'mock-small', usage: { input_tokens: 7, output_tokens: 2 } });
    expect(typeof done.ttft_ms).toBe('number');
    expect(lastLog()).toMatchObject({ api_key_id: 'playground', status: 'success', output_tokens: 2 });
  });

  it('streams an error event when the provider fails', async () => {
    const res = await chat({ provider_id: 'p-dead', stream: true, messages: hello });
    const events = sseEvents(res.payload);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('Dead');
    expect(lastLog()).toMatchObject({ api_key_id: 'playground', status: 'error' });
  });
});
