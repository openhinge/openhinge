import type { FastifyInstance } from 'fastify';
import { execSync } from 'node:child_process';
import { getDb } from '../../db/index.js';

export async function settingsAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/settings', async () => {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as any[];
    const settings: Record<string, any> = {};
    for (const row of rows) {
      settings[row.key] = JSON.parse(row.value);
    }
    return { data: settings };
  });

  app.get<{ Params: { key: string } }>('/admin/settings/:key', async (request) => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(request.params.key) as any;
    if (!row) return { data: null };
    return { data: JSON.parse(row.value) };
  });

  app.put<{ Params: { key: string }; Body: any }>('/admin/settings/:key', async (request) => {
    const { key } = request.params;
    const value = JSON.stringify(request.body);
    getDb().prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    ).run(key, value);
    return { ok: true };
  });

  // Cloudflare API proxy — fetch zones for domain picker
  app.post<{ Body: { api_token: string; account_id?: string } }>('/admin/cloudflare/zones', async (request, reply) => {
    const { api_token } = request.body;
    if (!api_token) return reply.code(400).send({ error: 'API token required' });

    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50&status=active', {
        headers: { 'Authorization': `Bearer ${api_token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json() as any;
      if (!data.success) return reply.code(400).send({ error: data.errors?.[0]?.message || 'CF API error' });

      const zones = (data.result || []).map((z: any) => ({
        id: z.id,
        name: z.name,
        account_id: z.account?.id,
        account_name: z.account?.name,
        status: z.status,
      }));
      return { data: zones };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Cloudflare API proxy — fetch tunnels
  app.post<{ Body: { api_token: string; account_id: string } }>('/admin/cloudflare/tunnels', async (request, reply) => {
    const { api_token, account_id } = request.body;
    if (!api_token || !account_id) return reply.code(400).send({ error: 'API token and account_id required' });

    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel?is_deleted=false&per_page=50`, {
        headers: { 'Authorization': `Bearer ${api_token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json() as any;
      if (!data.success) return reply.code(400).send({ error: data.errors?.[0]?.message || 'CF API error' });

      const tunnels = (data.result || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        connections: t.connections?.length || 0,
      }));
      return { data: tunnels };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Cloudflare API proxy — fetch DNS records for a zone
  app.post<{ Body: { api_token: string; zone_id: string } }>('/admin/cloudflare/dns', async (request, reply) => {
    const { api_token, zone_id } = request.body;
    if (!api_token || !zone_id) return reply.code(400).send({ error: 'API token and zone_id required' });

    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=CNAME&per_page=100`, {
        headers: { 'Authorization': `Bearer ${api_token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json() as any;
      if (!data.success) return reply.code(400).send({ error: data.errors?.[0]?.message || 'CF API error' });

      const records = (data.result || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        content: r.content,
        type: r.type,
        proxied: r.proxied,
      }));
      return { data: records };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Check tunnel connection status
  app.post<{ Body: { api_token: string; account_id: string; tunnel_id: string } }>('/admin/cloudflare/tunnel-status', async (request, reply) => {
    const { api_token, account_id, tunnel_id } = request.body;
    if (!api_token || !account_id || !tunnel_id) return reply.code(400).send({ error: 'api_token, account_id, tunnel_id required' });

    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel/${tunnel_id}`, {
        headers: { 'Authorization': `Bearer ${api_token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json() as any;
      if (!data.success) return reply.code(400).send({ error: data.errors?.[0]?.message || 'CF API error' });

      const tunnel = data.result;
      const conns = tunnel.connections || [];
      return {
        data: {
          id: tunnel.id,
          name: tunnel.name,
          status: tunnel.status,
          is_connected: conns.length > 0,
          connections: conns.map((c: any) => ({
            id: c.id,
            origin_ip: c.origin_ip,
            opened_at: c.opened_at,
          })),
        },
      };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Create DNS CNAME record pointing to tunnel
  app.post<{ Body: { api_token: string; zone_id: string; name: string; tunnel_id: string } }>('/admin/cloudflare/dns/create', async (request, reply) => {
    const { api_token, zone_id, name, tunnel_id } = request.body;
    if (!api_token || !zone_id || !name || !tunnel_id) return reply.code(400).send({ error: 'All fields required' });

    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${api_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'CNAME',
          name,
          content: `${tunnel_id}.cfargotunnel.com`,
          proxied: true,
          ttl: 1, // auto
        }),
      });
      const data = await res.json() as any;
      if (!data.success) return reply.code(400).send({ error: data.errors?.[0]?.message || 'Failed to create DNS record' });

      return { data: { id: data.result.id, name: data.result.name, content: data.result.content } };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Check if cloudflared is running locally
  app.get('/admin/cloudflare/local-status', async () => {
    try {
      const output = execSync('pgrep -f "cloudflared tunnel" 2>/dev/null | head -1', { encoding: 'utf-8', timeout: 3000 }).trim();
      return { data: { running: !!output, pid: output || null } };
    } catch {
      return { data: { running: false, pid: null } };
    }
  });
}
