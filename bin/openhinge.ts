#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../src/config/index.js';
import { initDatabase, getDb, closeDatabase } from '../src/db/index.js';
import { loadProviders, getAllProviders, checkAllHealth } from '../src/providers/index.js';
import { encrypt } from '../src/utils/crypto.js';
import { generateId } from '../src/utils/crypto.js';
import * as souls from '../src/souls/repository.js';
import * as keys from '../src/keys/repository.js';

const program = new Command();

program
  .name('openhinge')
  .description('OpenHinge AI Gateway CLI')
  .version('0.1.0');

// Init command — generates config and runs migrations
program.command('init')
  .description('Initialize OpenHinge (create config, run migrations)')
  .action(async () => {
    const { randomBytes } = await import('node:crypto');
    const { writeFileSync, existsSync, mkdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const configDir = resolve(process.cwd(), 'config');
    const configPath = resolve(configDir, 'openhinge.json');

    if (existsSync(configPath)) {
      console.log('Config already exists at config/openhinge.json');
    } else {
      mkdirSync(configDir, { recursive: true });
      const config = {
        server: { host: '127.0.0.1', port: 3700 },
        auth: { adminToken: randomBytes(24).toString('hex') },
        encryption: { key: randomBytes(32).toString('hex') },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Created config/openhinge.json');
      console.log(`Admin token: ${config.auth.adminToken}`);
      console.log('Save this token — you need it for admin API access.');
    }

    // Run migrations
    const cfg = loadConfig();
    initDatabase(cfg.db.path);
    closeDatabase();
    console.log('Database initialized.');
  });

// Migrate command
program.command('migrate')
  .description('Run database migrations')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.db.path);
    closeDatabase();
    console.log('Migrations complete.');
  });

// Provider commands
const providerCmd = program.command('provider').description('Manage LLM providers');

providerCmd.command('list')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.db.path);
    const rows = getDb().prepare('SELECT id, name, type, priority, is_enabled, health_status FROM providers ORDER BY priority DESC').all();
    console.table(rows);
    closeDatabase();
  });

providerCmd.command('add')
  .requiredOption('-n, --name <name>', 'Provider name')
  .requiredOption('-t, --type <type>', 'Type: claude, openai, gemini, ollama')
  .option('-u, --url <url>', 'Base URL')
  .option('-k, --key <key>', 'API key or OAuth token')
  .option('-m, --model <model>', 'Default model')
  .option('-p, --priority <n>', 'Priority (higher = preferred)', '0')
  .action((opts) => {
    const config = loadConfig();
    initDatabase(config.db.path);

    const id = generateId();
    const credentials: Record<string, string> = {};
    if (opts.key) {
      credentials[opts.key.startsWith('sk-ant-oat01-') ? 'oauth_token' : 'api_key'] = opts.key;
    }
    const providerConfig = opts.model ? { default_model: opts.model } : {};

    getDb().prepare(`
      INSERT INTO providers (id, name, type, base_url, config, credentials, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.name, opts.type, opts.url || null,
      JSON.stringify(providerConfig),
      encrypt(JSON.stringify(credentials), config.encryption.key),
      parseInt(opts.priority, 10),
    );

    console.log(`Provider added: ${opts.name} (${id})`);
    closeDatabase();
  });

providerCmd.command('health')
  .action(async () => {
    const config = loadConfig();
    initDatabase(config.db.path);
    loadProviders(config.encryption.key);
    const results = await checkAllHealth(config.encryption.key);
    for (const [id, health] of results) {
      console.log(`${id}: ${health.status} (${health.latency_ms}ms) ${health.message || ''}`);
    }
    closeDatabase();
  });

// Soul commands
const soulCmd = program.command('soul').description('Manage souls');

soulCmd.command('list')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.db.path);
    const all = souls.getAllSouls().map(s => ({
      id: s.id, name: s.name, slug: s.slug, provider: s.provider_id || 'default',
      model: s.model || 'default', enabled: s.is_enabled,
    }));
    console.table(all);
    closeDatabase();
  });

soulCmd.command('add')
  .requiredOption('-n, --name <name>', 'Soul name')
  .requiredOption('-s, --system-prompt <prompt>', 'System prompt')
  .option('--slug <slug>', 'URL slug')
  .option('-p, --provider <id>', 'Provider ID')
  .option('-m, --model <model>', 'Model override')
  .action((opts) => {
    const config = loadConfig();
    initDatabase(config.db.path);
    const soul = souls.createSoul({
      name: opts.name,
      slug: opts.slug,
      system_prompt: opts.systemPrompt,
      provider_id: opts.provider,
      model: opts.model,
    });
    console.log(`Soul created: ${soul.name} (${soul.slug})`);
    console.log(`Endpoint: POST /v1/souls/${soul.slug}/chat/completions`);
    closeDatabase();
  });

// Key commands
const keyCmd = program.command('key').description('Manage API keys');

keyCmd.command('list')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.db.path);
    const all = keys.getAllKeys().map(k => ({
      id: k.id, name: k.name, prefix: k.key_prefix, soul: k.soul_id || 'all',
      rpm: k.rate_limit_rpm, requests: k.total_requests, enabled: k.is_enabled,
    }));
    console.table(all);
    closeDatabase();
  });

keyCmd.command('create')
  .requiredOption('-n, --name <name>', 'Key name')
  .option('-s, --soul <id>', 'Bind to soul ID')
  .option('-r, --rpm <n>', 'Rate limit per minute', '60')
  .action((opts) => {
    const config = loadConfig();
    initDatabase(config.db.path);
    const key = keys.createKey({
      name: opts.name,
      soul_id: opts.soul,
      rate_limit_rpm: parseInt(opts.rpm, 10),
    });
    console.log(`API key created: ${key.name}`);
    console.log(`Key: ${key.key}`);
    console.log('Save this key — it will not be shown again.');
    closeDatabase();
  });

// Status command
program.command('status')
  .description('Show system status')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.db.path);
    const db = getDb();

    const providerCount = (db.prepare('SELECT COUNT(*) as c FROM providers WHERE is_enabled = 1').get() as any).c;
    const soulCount = (db.prepare('SELECT COUNT(*) as c FROM souls WHERE is_enabled = 1').get() as any).c;
    const keyCount = (db.prepare('SELECT COUNT(*) as c FROM api_keys WHERE is_enabled = 1').get() as any).c;
    const totalReqs = (db.prepare('SELECT COUNT(*) as c FROM usage_logs').get() as any).c;
    const todayReqs = (db.prepare("SELECT COUNT(*) as c FROM usage_logs WHERE created_at >= date('now')").get() as any).c;

    console.log('OpenHinge Status');
    console.log('================');
    console.log(`Providers:    ${providerCount}`);
    console.log(`Souls:        ${soulCount}`);
    console.log(`API Keys:     ${keyCount}`);
    console.log(`Total Reqs:   ${totalReqs}`);
    console.log(`Today Reqs:   ${todayReqs}`);

    closeDatabase();
  });

// Update command — pull latest, install deps, rebuild, migrate
program.command('update')
  .description('Update OpenHinge to the latest version')
  .action(async () => {
    const { execSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { readFileSync } = await import('node:fs');

    // import.meta.dirname = dist/bin/ in compiled, bin/ in dev — find project root via package.json
    let root = resolve(import.meta.dirname, '..');
    const { existsSync } = await import('node:fs');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');
    const currentPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
    console.log(`Current version: ${currentPkg.version}`);
    console.log('Checking for updates...');

    try {
      execSync('git fetch origin', { cwd: root, stdio: 'pipe' });
      const behind = execSync('git rev-list HEAD..origin/main --count', { cwd: root, encoding: 'utf-8' }).trim();

      if (behind === '0') {
        console.log('Already up to date.');
        return;
      }

      console.log(`${behind} new commit(s) available. Updating...`);
      execSync('git pull --ff-only origin main', { cwd: root, stdio: 'inherit' });

      console.log('Installing dependencies...');
      execSync('npm install --production=false', { cwd: root, stdio: 'inherit' });

      console.log('Building...');
      execSync('npm run build', { cwd: root, stdio: 'inherit' });

      // Auto-migrate in case schema changed
      const config = loadConfig();
      initDatabase(config.db.path);
      closeDatabase();
      console.log('Migrations applied.');

      const newPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
      console.log(`\nUpdated: ${currentPkg.version} → ${newPkg.version}`);
      console.log('Restart OpenHinge to apply changes.');
    } catch (err: any) {
      console.error(`Update failed: ${err.message}`);
      process.exit(1);
    }
  });

// Uninstall command — remove global link, data, and install dir
program.command('uninstall')
  .description('Uninstall OpenHinge completely')
  .action(async () => {
    const { execSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const readline = await import('node:readline');

    let root = resolve(import.meta.dirname, '..');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(r => rl.question('This will remove OpenHinge and all data. Continue? (y/N) ', r));
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    // Remove global npm link
    console.log('Removing global link...');
    try {
      execSync('npm unlink -g openhinge', { cwd: root, stdio: 'pipe' });
    } catch {
      // May need sudo
      try { execSync('sudo npm unlink -g openhinge', { stdio: 'pipe' }); } catch { /* already gone */ }
    }

    // Remove install directory
    console.log(`Removing ${root}...`);
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });

    console.log('OpenHinge uninstalled.');
  });

program.parse();
