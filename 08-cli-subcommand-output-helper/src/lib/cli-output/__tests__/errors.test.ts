import { describe, it, expect } from 'vitest';
import { CliError, NotFoundError, UsageError } from '../errors.js';

describe('CliError hierarchy', () => {
  it('CliError carries exitCode on the instance', () => {
    const err = new CliError('boom', 1);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('CliError');
  });

  it('NotFoundError extends CliError with exitCode = 3 and a derived message', () => {
    const err = new NotFoundError('index', 'demo');
    expect(err).toBeInstanceOf(CliError);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toBe('index not found: demo');
    expect(err.name).toBe('NotFoundError');
  });

  it('UsageError extends CliError with exitCode = 2', () => {
    const err = new UsageError('missing required argument');
    expect(err).toBeInstanceOf(CliError);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('missing required argument');
    expect(err.name).toBe('UsageError');
  });

  it('instanceof discriminates CliError descendants from generic Errors at the boundary', () => {
    const notFound: unknown = new NotFoundError('index', 'demo');
    const usage: unknown = new UsageError('missing arg');
    const generic: unknown = new Error('something else');

    expect(notFound instanceof CliError).toBe(true);
    expect(usage instanceof CliError).toBe(true);
    expect(generic instanceof CliError).toBe(false);
  });
});
