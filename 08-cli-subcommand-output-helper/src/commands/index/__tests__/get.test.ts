import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createInMemoryWriter,
  type InMemoryWriter,
} from '../../../__tests__/fixtures/in-memory-writer.js';
import {
  createFakeIndexClient,
  DEFAULT_INDEX,
  type FakeClientOptions,
} from '../../../__tests__/fixtures/index-client.js';
import { createGetCommand } from '../get.js';
import type { OutputFormat } from '../../../lib/cli-output/renderer.js';

interface Harness {
  readonly stdout: InMemoryWriter;
  readonly stderr: InMemoryWriter;
}

let harness: Harness;

beforeEach(() => {
  harness = {
    stdout: createInMemoryWriter(),
    stderr: createInMemoryWriter(),
  };
  // Reset between tests so an earlier failure can't bleed across cases.
  process.exitCode = 0;
});

// G-T10: suite-wide enforcement that the subcommand never writes to stderr,
// regardless of mode. Any new test in this file automatically participates.
afterEach(() => {
  expect(harness.stderr.toString()).toBe('');
});

function build(opts: {
  readonly isTTY: boolean;
  readonly resolveOutput: () => OutputFormat | undefined;
  readonly clientOpts?: FakeClientOptions;
}): ReturnType<typeof createGetCommand> {
  return createGetCommand({
    client: createFakeIndexClient(opts.clientOpts ?? { index: DEFAULT_INDEX }),
    stdout: harness.stdout.writer,
    stderr: harness.stderr.writer,
    isTTY: opts.isTTY,
    noColor: true,
    signal: new AbortController().signal,
    resolveOutput: opts.resolveOutput,
  });
}

describe('pcsk index get — format resolution', () => {
  // G-T1
  it('auto-detects JSON when isTTY=false and --output is omitted', async () => {
    const cmd = build({ isTTY: false, resolveOutput: () => undefined });
    await cmd.parseAsync(['demo'], { from: 'user' });

    const out = harness.stdout.toString();
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.slice(0, -1)) as unknown;
    expect(parsed).toEqual({ ok: true, data: DEFAULT_INDEX, exitCode: 0 });
  });

  // G-T2
  it('auto-detects table when isTTY=true and --output is omitted', async () => {
    const cmd = build({ isTTY: true, resolveOutput: () => undefined });
    await cmd.parseAsync(['demo'], { from: 'user' });

    const out = harness.stdout.toString();
    expect(out).toContain(DEFAULT_INDEX.name);
    expect(out).toContain(DEFAULT_INDEX.status);
    // Not the JSON envelope shape.
    expect(out).not.toContain('"ok":true');
  });

  // G-T3
  it('honors explicit --output=json even when isTTY=true', async () => {
    const cmd = build({ isTTY: true, resolveOutput: () => 'json' });
    await cmd.parseAsync(['demo'], { from: 'user' });

    const out = harness.stdout.toString();
    const parsed = JSON.parse(out.slice(0, -1)) as unknown;
    expect(parsed).toEqual({ ok: true, data: DEFAULT_INDEX, exitCode: 0 });
    // Not a table.
    expect(out).not.toMatch(/[┌│└─]/);
  });

  // G-T4
  it('honors explicit --output=table even when isTTY=false', async () => {
    const cmd = build({ isTTY: false, resolveOutput: () => 'table' });
    await cmd.parseAsync(['demo'], { from: 'user' });

    const out = harness.stdout.toString();
    expect(out).toContain(DEFAULT_INDEX.name);
    // Not a JSON envelope.
    expect(out).not.toContain('"ok":true');
  });
});

describe('pcsk index get — error path propagation', () => {
  // G-T5
  it('emits a NOT_FOUND envelope on stdout and sets exitCode=3 (JSON mode)', async () => {
    const cmd = build({
      isTTY: false,
      resolveOutput: () => undefined,
      clientOpts: { notFound: true },
    });
    await cmd.parseAsync(['demo'], { from: 'user' });

    const out = harness.stdout.toString();
    const parsed = JSON.parse(out.slice(0, -1)) as unknown;
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'index not found: demo' },
      exitCode: 3,
    });
    expect(process.exitCode).toBe(3);
  });

  // G-T6
  it('writes "error [NOT_FOUND]: …" on stdout and sets exitCode=3 (table mode)', async () => {
    const cmd = build({
      isTTY: true,
      resolveOutput: () => undefined,
      clientOpts: { notFound: true },
    });
    await cmd.parseAsync(['demo'], { from: 'user' });

    expect(harness.stdout.toString()).toBe('error [NOT_FOUND]: index not found: demo\n');
    expect(process.exitCode).toBe(3);
  });

  // G-T7
  it('emits an INTERNAL envelope on stdout and sets exitCode=1 for a generic Error', async () => {
    const cmd = build({
      isTTY: false,
      resolveOutput: () => undefined,
      clientOpts: { error: new Error('boom') },
    });
    await cmd.parseAsync(['demo'], { from: 'user' });

    const parsed = JSON.parse(harness.stdout.toString().slice(0, -1)) as unknown;
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'boom' },
      exitCode: 1,
    });
    expect(process.exitCode).toBe(1);
  });

  // G-T8: parseAsync resolves cleanly for every client-originated error path.
  it('parseAsync never rejects for client-originated errors', async () => {
    const scenarios: readonly FakeClientOptions[] = [
      { notFound: true },
      { error: new Error('boom') },
    ];

    for (const clientOpts of scenarios) {
      harness = {
        stdout: createInMemoryWriter(),
        stderr: createInMemoryWriter(),
      };
      const cmd = build({
        isTTY: false,
        resolveOutput: () => undefined,
        clientOpts,
      });
      // Wrapping in try/catch and asserting catch never fires is the spec form.
      let caught: unknown = undefined;
      try {
        await cmd.parseAsync(['demo'], { from: 'user' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeUndefined();
    }
  });
});
