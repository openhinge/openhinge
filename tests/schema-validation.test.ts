import { describe, it, expect } from 'vitest';

// Inline the validator for unit testing (same logic as in chat.ts)
interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  [key: string]: unknown;
}

function validateBasicSchema(data: unknown, schema: JsonSchema): boolean {
  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    const obj = data as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) return false;
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj && propSchema && typeof propSchema === 'object' && 'type' in propSchema) {
          const ps = propSchema as JsonSchema;
          if (ps.type === 'string' && typeof obj[key] !== 'string') return false;
          if (ps.type === 'number' && typeof obj[key] !== 'number') return false;
          if (ps.type === 'integer' && (typeof obj[key] !== 'number' || !Number.isInteger(obj[key]))) return false;
          if (ps.type === 'boolean' && typeof obj[key] !== 'boolean') return false;
          if (ps.type === 'array' && !Array.isArray(obj[key])) return false;
          if (ps.type === 'object' && (typeof obj[key] !== 'object' || obj[key] === null || Array.isArray(obj[key]))) return false;
        }
      }
    }
    return true;
  }
  if (schema.type === 'array') return Array.isArray(data);
  if (schema.type === 'string') return typeof data === 'string';
  if (schema.type === 'number') return typeof data === 'number';
  if (schema.type === 'boolean') return typeof data === 'boolean';
  return true;
}

describe('validateBasicSchema', () => {
  const personSchema: JsonSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
      email: { type: 'string' },
    },
    required: ['name', 'age'],
  };

  it('validates correct object', () => {
    expect(validateBasicSchema({ name: 'Ahmet', age: 30 }, personSchema)).toBe(true);
  });

  it('validates with extra fields', () => {
    expect(validateBasicSchema({ name: 'Ahmet', age: 30, extra: true }, personSchema)).toBe(true);
  });

  it('fails on missing required field', () => {
    expect(validateBasicSchema({ name: 'Ahmet' }, personSchema)).toBe(false);
  });

  it('fails on wrong type', () => {
    expect(validateBasicSchema({ name: 'Ahmet', age: '30' }, personSchema)).toBe(false);
  });

  it('fails on non-integer for integer type', () => {
    expect(validateBasicSchema({ name: 'Ahmet', age: 30.5 }, personSchema)).toBe(false);
  });

  it('fails on null', () => {
    expect(validateBasicSchema(null, personSchema)).toBe(false);
  });

  it('fails on array instead of object', () => {
    expect(validateBasicSchema([1, 2], personSchema)).toBe(false);
  });

  it('validates array schema', () => {
    expect(validateBasicSchema([1, 2, 3], { type: 'array' })).toBe(true);
    expect(validateBasicSchema('hello', { type: 'array' })).toBe(false);
  });

  it('validates string schema', () => {
    expect(validateBasicSchema('hello', { type: 'string' })).toBe(true);
    expect(validateBasicSchema(123, { type: 'string' })).toBe(false);
  });

  it('validates boolean schema', () => {
    expect(validateBasicSchema(true, { type: 'boolean' })).toBe(true);
    expect(validateBasicSchema('true', { type: 'boolean' })).toBe(false);
  });

  it('validates nested object types', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        tags: { type: 'array' },
        meta: { type: 'object' },
      },
      required: ['tags'],
    };
    expect(validateBasicSchema({ tags: ['a', 'b'], meta: { x: 1 } }, schema)).toBe(true);
    expect(validateBasicSchema({ tags: 'not-array' }, schema)).toBe(false);
    expect(validateBasicSchema({ tags: [], meta: null }, schema)).toBe(false);
    expect(validateBasicSchema({ tags: [], meta: [1] }, schema)).toBe(false);
  });
});
