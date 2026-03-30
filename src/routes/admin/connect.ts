import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getAllProviders } from '../../providers/index.js';
import { logger } from '../../utils/logger.js';

interface ConnectableApp {
  id: string;
  name: string;
  detected: boolean;
  connected: boolean;
  configPath: string;
}

function getOpenClawConfigPath(): string {
  return resolve(homedir(), '.openclaw/openclaw.json');
}

function detectApps(): ConnectableApp[] {
  const apps: ConnectableApp[] = [];

  // OpenClaw
  const ocPath = getOpenClawConfigPath();
  const ocExists = existsSync(ocPath);
  let ocConnected = false;
  if (ocExists) {
    try {
      const oc = JSON.parse(readFileSync(ocPath, 'utf-8'));
      ocConnected = !!oc.models?.providers?.openhinge;
    } catch {}
  }
  apps.push({
    id: 'openclaw',
    name: 'OpenClaw',
    detected: ocExists,
    connected: ocConnected,
    configPath: ocPath,
  });

  return apps;
}

export async function connectAdminRoutes(app: FastifyInstance): Promise<void> {
  // Detect connectable apps
  app.get('/admin/connect/detect', async () => {
    return { apps: detectApps() };
  });

  // Connect an app with a specific API key
  app.post<{ Body: { app: string; api_key: string } }>('/admin/connect', async (request, reply) => {
    const { app: appId, api_key } = request.body || {};

    if (!appId || !api_key) {
      return reply.code(400).send({ error: 'Missing app or api_key' });
    }

    if (appId === 'openclaw') {
      return connectOpenClaw(api_key, reply);
    }

    return reply.code(400).send({ error: `Unknown app: ${appId}` });
  });

  // Disconnect an app
  app.post<{ Body: { app: string } }>('/admin/connect/disconnect', async (request, reply) => {
    const { app: appId } = request.body || {};

    if (appId === 'openclaw') {
      return disconnectOpenClaw(reply);
    }

    return reply.code(400).send({ error: `Unknown app: ${appId}` });
  });
}

async function connectOpenClaw(apiKey: string, reply: any) {
  const ocPath = getOpenClawConfigPath();
  if (!existsSync(ocPath)) {
    return reply.code(404).send({ error: 'OpenClaw not found at ~/.openclaw/openclaw.json' });
  }

  try {
    const oc = JSON.parse(readFileSync(ocPath, 'utf-8'));

    // Discover available models
    const providers = getAllProviders();
    const modelList: Array<{ id: string; name: string }> = [];
    for (const p of providers) {
      try {
        const models = await p.listModels();
        for (const m of models) {
          modelList.push({ id: m, name: m });
        }
      } catch {}
    }

    // Build OpenClaw provider config
    const openhingeProvider: Record<string, unknown> = {
      baseUrl: 'http://127.0.0.1:3700/v1',
      apiKey: apiKey,
      api: 'openai-completions',
      models: modelList.slice(0, 10).map(m => ({
        id: m.id,
        name: m.name,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      })),
    };

    // Inject
    if (!oc.models) oc.models = {};
    if (!oc.models.providers) oc.models.providers = {};
    oc.models.providers.openhinge = openhingeProvider;

    // Add as fallbacks
    if (oc.agents?.defaults?.model?.fallbacks && modelList.length > 0) {
      oc.agents.defaults.model.fallbacks = oc.agents.defaults.model.fallbacks
        .filter((f: string) => !f.startsWith('openhinge/'));
      for (const m of modelList.slice(0, 3)) {
        oc.agents.defaults.model.fallbacks.push(`openhinge/${m.id}`);
      }
    }

    writeFileSync(ocPath, JSON.stringify(oc, null, 2));

    logger.info({ models: modelList.length }, 'OpenClaw connected to OpenHinge');
    return {
      ok: true,
      models: modelList.slice(0, 10).map(m => m.id),
      message: `Connected with ${modelList.length} models`,
    };
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to connect OpenClaw');
    return reply.code(500).send({ error: `Failed to update OpenClaw config: ${err.message}` });
  }
}

async function disconnectOpenClaw(reply: any) {
  const ocPath = getOpenClawConfigPath();
  if (!existsSync(ocPath)) {
    return reply.code(404).send({ error: 'OpenClaw not found' });
  }

  try {
    const oc = JSON.parse(readFileSync(ocPath, 'utf-8'));

    if (oc.models?.providers?.openhinge) {
      delete oc.models.providers.openhinge;
    }
    if (oc.agents?.defaults?.model?.primary?.startsWith('openhinge/')) {
      oc.agents.defaults.model.primary = 'anthropic/claude-sonnet-4-6';
    }
    if (oc.agents?.defaults?.model?.fallbacks) {
      oc.agents.defaults.model.fallbacks = oc.agents.defaults.model.fallbacks
        .filter((f: string) => !f.startsWith('openhinge/'));
    }

    writeFileSync(ocPath, JSON.stringify(oc, null, 2));
    logger.info('OpenClaw disconnected from OpenHinge');
    return { ok: true };
  } catch (err: any) {
    return reply.code(500).send({ error: err.message });
  }
}
