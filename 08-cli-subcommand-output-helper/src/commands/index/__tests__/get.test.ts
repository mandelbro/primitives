import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createInMemoryWriter,
  type InMemoryWriter,
} from '../../../__tests__/fixtures/in-memory-writer.js';
import {
  createFakeIndexClient,
  DEFAULT_INDEX,
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
}): ReturnType<typeof createGetCommand> {
  return createGetCommand({
    client: createFakeIndexClient({ index: DEFAULT_INDEX }),
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
