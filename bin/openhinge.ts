#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { loadConfig } from '../src/config/index.js';
import { initDatabase, getDb, closeDatabase } from '../src/db/index.js';
import { loadProviders, getAllProviders, checkAllHealth } from '../src/providers/index.js';
import { encrypt } from '../src/utils/crypto.js';
import { generateId } from '../src/utils/crypto.js';
import * as souls from '../src/souls/repository.js';
import * as keys from '../src/keys/repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('openhinge')
  .description('OpenHinge AI Gateway CLI')
  .version(pkg.version);

// Start command — start the gateway server (background by default)
program.command('start')
  .description('Start the OpenHinge gateway server (runs in background)')
  .option('-f, --foreground', 'Run in foreground (blocks terminal)')
  .action(async (opts) => {
    const { resolve } = await import('node:path');
    const { existsSync, openSync, mkdirSync, writeFileSync } = await import('node:fs');

    let root = resolve(import.meta.dirname, '..');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');
    const entry = resolve(root, 'dist/src/index.js');

    if (!existsSync(entry)) {
      console.error('Server not built. Run: npm run build');
      process.exit(1);
    }

    // Check if already running
    const { execSync } = await import('node:child_process');
    try {
      const pids = execSync('lsof -ti:3700', { encoding: 'utf-8' }).trim();
      if (pids) {
        console.log('OpenHinge is already running on port 3700.');
        return;
      }
    } catch { /* not running */ }

    if (opts.foreground) {
      const { spawn } = await import('node:child_process');
      const server = spawn('node', [entry], {
        cwd: root,
        stdio: 'inherit',
      });
      server.on('exit', (code) => process.exit(code || 0));
      process.on('SIGINT', () => server.kill('SIGINT'));
      process.on('SIGTERM', () => server.kill('SIGTERM'));
    } else {
      const { spawn } = await import('node:child_process');
      const dataDir = resolve(root, 'data');
      mkdirSync(dataDir, { recursive: true });
      const logFile = resolve(dataDir, 'openhinge.log');
      const pidFile = resolve(dataDir, 'openhinge.pid');
      const out = openSync(logFile, 'a');
      const server = spawn('node', [entry], {
        cwd: root,
        detached: true,
        stdio: ['ignore', out, out],
      });
      server.unref();
      // Save PID for reliable stop
      if (server.pid) writeFileSync(pidFile, String(server.pid));
      console.log(`OpenHinge started (PID ${server.pid})`);
      console.log(`Dashboard: http://127.0.0.1:3700/dashboard/`);
      console.log(`Logs: ${logFile}`);
    }
  });

// Stop command — stop the gateway server
program.command('stop')
  .description('Stop the OpenHinge gateway server')
  .action(async () => {
    const { execSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { readFileSync, unlinkSync, existsSync } = await import('node:fs');

    let root = resolve(import.meta.dirname, '..');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');
    const pidFile = resolve(root, 'data/openhinge.pid');

    // Try PID file first
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 'SIGTERM');
        try { unlinkSync(pidFile); } catch {}
        console.log('OpenHinge stopped.');
        return;
      } catch { /* stale PID file */ }
      try { unlinkSync(pidFile); } catch {}
    }

    // Fallback: find by port
    try {
      const pids = execSync('lsof -ti:3700', { encoding: 'utf-8' }).trim();
      if (!pids) {
        console.log('OpenHinge is not running.');
        return;
      }
      for (const pid of pids.split('\n')) {
        try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
      }
      console.log('OpenHinge stopped.');
    } catch {
      console.log('OpenHinge is not running.');
    }
  });

// Restart command
program.command('restart')
  .description('Restart the OpenHinge gateway server')
  .action(async () => {
    const { execSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { existsSync, openSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } = await import('node:fs');
    const { spawn } = await import('node:child_process');

    let root = resolve(import.meta.dirname, '..');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');
    const entry = resolve(root, 'dist/src/index.js');
    const dataDir = resolve(root, 'data');
    const pidFile = resolve(dataDir, 'openhinge.pid');

    // Stop — try PID file first
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      try { process.kill(pid, 'SIGTERM'); } catch {}
      try { unlinkSync(pidFile); } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    // Also kill by port as fallback
    try {
      const pids = execSync('lsof -ti:3700', { encoding: 'utf-8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch { /* wasn't running */ }

    // Start in background
    mkdirSync(dataDir, { recursive: true });
    const logFile = resolve(dataDir, 'openhinge.log');
    const out = openSync(logFile, 'a');
    const server = spawn('node', [entry], {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
    });
    server.unref();
    if (server.pid) writeFileSync(pidFile, String(server.pid));
    console.log(`OpenHinge restarted (PID ${server.pid})`);
    console.log(`Dashboard: http://127.0.0.1:3700/dashboard/`);
  });

// Startup command — enable/disable launch on boot
program.command('startup')
  .description('Enable or disable OpenHinge launch on system boot')
  .option('--disable', 'Remove startup configuration')
  .action(async (opts) => {
    const { resolve } = await import('node:path');
    const { existsSync, writeFileSync, unlinkSync, mkdirSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    const { platform, homedir } = await import('node:os');

    let root = resolve(import.meta.dirname, '..');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');
    const entry = resolve(root, 'dist/src/index.js');
    const nodePath = execSync('which node', { encoding: 'utf-8' }).trim();

    if (platform() === 'darwin') {
      // macOS: launchd plist
      const plistDir = resolve(homedir(), 'Library/LaunchAgents');
      const plistPath = resolve(plistDir, 'com.openhinge.gateway.plist');

      if (opts.disable) {
        try { execSync(`launchctl unload ${plistPath}`, { stdio: 'pipe' }); } catch {}
        try { unlinkSync(plistPath); } catch {}
        console.log('OpenHinge startup disabled.');
        return;
      }

      mkdirSync(plistDir, { recursive: true });
      const logFile = resolve(root, 'data/openhinge.log');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openhinge.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${root}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>`;

      writeFileSync(plistPath, plist);
      execSync(`launchctl load ${plistPath}`, { stdio: 'inherit' });
      console.log('OpenHinge will start on boot (macOS launchd).');
      console.log(`Plist: ${plistPath}`);
    } else {
      // Linux: systemd user service
      const serviceDir = resolve(homedir(), '.config/systemd/user');
      const servicePath = resolve(serviceDir, 'openhinge.service');

      if (opts.disable) {
        try { execSync('systemctl --user disable openhinge', { stdio: 'pipe' }); } catch {}
        try { execSync('systemctl --user stop openhinge', { stdio: 'pipe' }); } catch {}
        try { unlinkSync(servicePath); } catch {}
        try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
        console.log('OpenHinge startup disabled.');
        return;
      }

      mkdirSync(serviceDir, { recursive: true });
      const service = `[Unit]
Description=OpenHinge AI Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${nodePath} ${entry}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

      writeFileSync(servicePath, service);
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      execSync('systemctl --user enable openhinge', { stdio: 'inherit' });
      execSync('systemctl --user start openhinge', { stdio: 'inherit' });
      // Enable lingering so user services run without login
      try { execSync(`loginctl enable-linger ${process.env.USER}`, { stdio: 'pipe' }); } catch {}
      console.log('OpenHinge will start on boot (systemd user service).');
      console.log(`Service: ${servicePath}`);
    }

    console.log('Logs: openhinge logs');
  });

// Logs command — view server logs
program.command('logs')
  .description('View OpenHinge server logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .action(async (opts) => {
    const { resolve } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const { execSync, spawn: nodeSpawn } = await import('node:child_process');

    let root = resolve(import.meta.dirname, '..');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');
    const logFile = resolve(root, 'data/openhinge.log');

    if (!existsSync(logFile)) {
      console.log('No logs yet. Start the server first: openhinge start');
      return;
    }

    if (opts.follow) {
      const tail = nodeSpawn('tail', ['-f', '-n', opts.lines, logFile], { stdio: 'inherit' });
      process.on('SIGINT', () => { tail.kill(); process.exit(0); });
    } else {
      execSync(`tail -n ${opts.lines} ${logFile}`, { stdio: 'inherit' });
    }
  });

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
        auth: {},
        encryption: { key: randomBytes(32).toString('hex') },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Created config/openhinge.json');
      console.log('Open the dashboard to set your password.');
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

providerCmd.command('add-claude')
  .description('Auto-import Claude subscription from this computer')
  .option('-n, --name <name>', 'Provider name')
  .option('-m, --model <model>', 'Default model')
  .option('-p, --priority <n>', 'Priority (higher = preferred)', '10')
  .action(async (opts) => {
    const { execSync } = await import('node:child_process');

    // Read Claude Code credentials from macOS Keychain
    let raw: string;
    try {
      raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      console.error('No Claude Code credentials found on this computer.');
      console.error('Make sure Claude Code is installed and you are logged in (/login).');
      process.exit(1);
    }

    let creds: any;
    try {
      creds = JSON.parse(raw);
    } catch {
      console.error('Failed to parse Claude Code credentials.');
      process.exit(1);
    }

    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) {
      console.error('No OAuth token found. Run /login in Claude Code first.');
      process.exit(1);
    }

    const config = loadConfig();
    initDatabase(config.db.path);

    const id = generateId();
    const subType = oauth.subscriptionType || 'unknown';
    const providerName = opts.name || `Claude (${subType})`;
    const credentials: Record<string, string> = {
      oauth_token: oauth.accessToken,
      refresh_token: oauth.refreshToken || '',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      expires_at: String(oauth.expiresAt || ''),
    };
    const providerConfig = opts.model ? { default_model: opts.model } : {};

    getDb().prepare(`
      INSERT INTO providers (id, name, type, base_url, config, credentials, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, providerName, 'claude', null,
      JSON.stringify(providerConfig),
      encrypt(JSON.stringify(credentials), config.encryption.key),
      parseInt(opts.priority, 10),
    );

    console.log(`Claude provider added: ${providerName} (${id})`);
    console.log(`Subscription: ${subType}`);
    console.log(`Token expires: ${new Date(oauth.expiresAt).toLocaleString()}`);
    console.log('Auto-refresh enabled with refresh token.');
    closeDatabase();
  });

providerCmd.command('refresh-claude')
  .description('Refresh Claude subscription token from this computer')
  .option('--id <id>', 'Provider ID to refresh (refreshes all Claude providers if omitted)')
  .action(async (opts) => {
    const { execSync } = await import('node:child_process');

    let raw: string;
    try {
      raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      console.error('No Claude Code credentials found on this computer.');
      process.exit(1);
    }

    const oauth = JSON.parse(raw).claudeAiOauth;
    if (!oauth?.accessToken) {
      console.error('No OAuth token found.');
      process.exit(1);
    }

    const config = loadConfig();
    initDatabase(config.db.path);

    const query = opts.id
      ? `SELECT id, name FROM providers WHERE id = ? AND type = 'claude'`
      : `SELECT id, name FROM providers WHERE type = 'claude'`;
    const rows = (opts.id
      ? [getDb().prepare(query).get(opts.id)]
      : getDb().prepare(query).all()
    ).filter(Boolean) as any[];

    if (rows.length === 0) {
      console.log('No Claude providers found.');
      closeDatabase();
      return;
    }

    for (const row of rows) {
      const credentials: Record<string, string> = {
        oauth_token: oauth.accessToken,
        refresh_token: oauth.refreshToken || '',
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        expires_at: String(oauth.expiresAt || ''),
      };

      getDb().prepare('UPDATE providers SET credentials = ? WHERE id = ?').run(
        encrypt(JSON.stringify(credentials), config.encryption.key),
        row.id,
      );

      console.log(`Refreshed: ${row.name} (${row.id})`);
    }

    console.log(`Token expires: ${new Date(oauth.expiresAt).toLocaleString()}`);
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

// Update command — self-contained, never relies on stale compiled logic
program.command('update')
  .description('Update OpenHinge to the latest version')
  .action(async () => {
    const { execSync, spawn: nodeSpawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { readFileSync } = await import('node:fs');

    let root = resolve(import.meta.dirname, '..');
    const { existsSync } = await import('node:fs');
    if (!existsSync(resolve(root, 'package.json'))) root = resolve(root, '..');
    const currentPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
    console.log(`Current version: ${currentPkg.version}`);
    console.log('Checking for updates...');

    try {
      // Always pull + rebuild — simple, reliable, no stale binary issues
      execSync('git fetch origin', { cwd: root, stdio: 'pipe' });
      execSync('git checkout -- package-lock.json', { cwd: root, stdio: 'pipe' });
      execSync('git pull --ff-only origin main', { cwd: root, stdio: 'inherit' });

      console.log('Installing dependencies...');
      execSync('npm install --production=false', { cwd: root, stdio: 'inherit' });

      console.log('Building...');
      execSync('npm run build', { cwd: root, stdio: 'inherit' });

      // Run migrations
      const config = loadConfig();
      initDatabase(config.db.path);
      closeDatabase();
      console.log('Migrations applied.');

      const newPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
      if (newPkg.version !== currentPkg.version) {
        console.log(`\nUpdated: ${currentPkg.version} → ${newPkg.version}`);
      } else {
        console.log('Rebuilt successfully.');
      }

      // Re-link globally in case bin changed
      try { execSync('npm link --silent', { cwd: root, stdio: 'pipe' }); } catch {
        try { execSync('sudo npm link --silent', { cwd: root, stdio: 'pipe' }); } catch {}
      }

      // Auto-restart server if running
      try {
        const pids = execSync('lsof -ti:3700', { encoding: 'utf-8' }).trim();
        if (pids) {
          console.log('Restarting server...');
          for (const pid of pids.split('\n')) {
            try { process.kill(parseInt(pid)); } catch {}
          }
          await new Promise(r => setTimeout(r, 1000));
          const server = nodeSpawn('node', [resolve(root, 'dist/src/index.js')], {
            cwd: root, detached: true, stdio: 'ignore',
          });
          server.unref();
          console.log('Server restarted.');
        }
      } catch {}

      console.log('Update complete.');
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

    // Kill running OpenHinge server
    console.log('Stopping OpenHinge server...');
    try {
      const pids = execSync('lsof -ti:3700', { encoding: 'utf-8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(parseInt(pid)); } catch { /* already dead */ }
        }
        console.log('Server stopped.');
      }
    } catch { /* nothing running on 3700 */ }

    // Remove global npm link
    console.log('Removing global link...');
    try {
      execSync('npm unlink -g openhinge', { cwd: root, stdio: 'pipe' });
    } catch {
      try { execSync('sudo npm unlink -g openhinge', { stdio: 'pipe' }); } catch { /* already gone */ }
    }

    // Remove install directory
    console.log(`Removing ${root}...`);
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });

    console.log('OpenHinge uninstalled.');
  });

program.parse();
