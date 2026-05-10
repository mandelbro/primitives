import { describe, expect, it } from 'vitest';
import { jwtAuth } from '../src/jwt-auth.js';
import type { JwtAuthOptions } from '../src/types.js';
import { defaultOpts } from './fixtures.js';

describe('jwtAuth options validation (H1)', () => {
  it.each<{ name: string; mutate: (o: JwtAuthOptions) => Partial<JwtAuthOptions> }>([
    {
      name: 'jwksUri missing',
      mutate: () => ({ jwksUri: undefined as unknown as string }),
    },
    {
      name: 'jwksUri not a parseable URL',
      mutate: () => ({ jwksUri: 'not a url' }),
    },
    {
      name: 'audience empty string',
      mutate: () => ({ audience: '' }),
    },
    {
      name: 'audience empty array',
      mutate: () => ({ audience: [] }),
    },
    {
      name: 'issuer missing',
      mutate: () => ({ issuer: undefined as unknown as string }),
    },
    {
      name: 'cacheTtlMs <= 0',
      mutate: () => ({ cacheTtlMs: 0 }),
    },
    {
      name: 'clockSkewSec < 0',
      mutate: () => ({ clockSkewSec: -1 }),
    },
  ])('throws synchronously when $name', ({ mutate }) => {
    const opts = { ...defaultOpts(), ...mutate(defaultOpts()) } as JwtAuthOptions;
    expect(() => jwtAuth(opts)).toThrow();
  });

  it('does not throw on a valid options object', () => {
    expect(() => jwtAuth(defaultOpts())).not.toThrow();
  });
});
