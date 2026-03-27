import type { FastifyInstance } from 'fastify';
import { getCostReport, getCostBySoul, getRecentLogs, queryLogs } from '../../cost/index.js';

export async function costAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { days?: string } }>('/admin/cost/report', async (request) => {
    const days = parseInt(request.query.days || '30', 10);
    return { data: getCostReport(days) };
  });

  app.get<{ Querystring: { days?: string } }>('/admin/cost/by-soul', async (request) => {
    const days = parseInt(request.query.days || '30', 10);
    return { data: getCostBySoul(days) };
  });

  // Legacy simple endpoint
  app.get<{ Querystring: { limit?: string } }>('/admin/cost/logs', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    return { data: getRecentLogs(limit) };
  });

  // Advanced query endpoint with filtering, pagination, sorting
  app.get<{ Querystring: Record<string, string> }>('/admin/cost/logs/query', async (request) => {
    const q = request.query;
    return queryLogs({
      page: q.page ? parseInt(q.page, 10) : undefined,
      per_page: q.per_page ? parseInt(q.per_page, 10) : undefined,
      soul_id: q.soul_id || undefined,
      provider_id: q.provider_id || undefined,
      api_key_id: q.api_key_id || undefined,
      model: q.model || undefined,
      status: q.status || undefined,
      search: q.search || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      sort: q.sort || undefined,
      order: (q.order === 'asc' ? 'asc' : q.order === 'desc' ? 'desc' : undefined),
    });
  });
}
