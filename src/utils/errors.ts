export class OpenHingeError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = 'OpenHingeError';
  }
}

export class AuthError extends OpenHingeError {
  constructor(message = 'Invalid or missing API key') {
    super(message, 401, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

export class NotFoundError extends OpenHingeError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends OpenHingeError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMIT');
    this.name = 'RateLimitError';
  }
}

export class BudgetExceededError extends OpenHingeError {
  constructor(message = 'Budget limit exceeded') {
    super(message, 402, 'BUDGET_EXCEEDED');
    this.name = 'BudgetExceededError';
  }
}

export class ProviderError extends OpenHingeError {
  constructor(provider: string, message: string) {
    super(`Provider [${provider}]: ${message}`, 502, 'PROVIDER_ERROR');
    this.name = 'ProviderError';
  }
}
