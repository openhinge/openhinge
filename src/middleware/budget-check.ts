import type { FastifyRequest, FastifyReply } from 'fastify';
import { BudgetExceededError } from '../utils/errors.js';
import { getDailySpend, getMonthlySpend } from '../cost/index.js';

export async function budgetCheckMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.apiKey;
  if (!key) return;

  if (key.daily_budget_cents) {
    const spent = getDailySpend(key.id);
    if (spent >= key.daily_budget_cents) {
      throw new BudgetExceededError(
        `Daily budget exceeded: $${(spent / 100).toFixed(2)} / $${(key.daily_budget_cents / 100).toFixed(2)}`
      );
    }
  }

  if (key.monthly_budget_cents) {
    const spent = getMonthlySpend(key.id);
    if (spent >= key.monthly_budget_cents) {
      throw new BudgetExceededError(
        `Monthly budget exceeded: $${(spent / 100).toFixed(2)} / $${(key.monthly_budget_cents / 100).toFixed(2)}`
      );
    }
  }
}
