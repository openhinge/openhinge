// Simple token estimator — ~4 chars per token for English text.
// Good enough for cost tracking. Swap for tiktoken if precision needed.

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Cost per 1M tokens in cents (provider defaults — overridden by provider config)
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // Claude (subscription = $0)
  'claude-opus-4-6': { input: 0, output: 0 },
  'claude-sonnet-4-6': { input: 0, output: 0 },
  'claude-haiku-4-5': { input: 0, output: 0 },

  // Claude API (pay-per-token)
  'claude-opus-4-6-api': { input: 1500, output: 7500 },
  'claude-sonnet-4-6-api': { input: 300, output: 1500 },

  // OpenAI
  'gpt-4o': { input: 250, output: 1000 },
  'gpt-4o-mini': { input: 15, output: 60 },
  'gpt-4.1': { input: 200, output: 800 },

  // Gemini
  'gemini-2.5-pro': { input: 125, output: 1000 },
  'gemini-2.5-flash': { input: 15, output: 60 },

  // Ollama (local = free)
  'qwen3:8b': { input: 0, output: 0 },
  'llama3:8b': { input: 0, output: 0 },
};

export function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const costs = MODEL_COSTS[model];
  if (!costs) return 0;
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}
