import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRenderer, type TableFormat } from '../renderer.js';
import { CliError, NotFoundError, UsageError } from '../errors.js';
import {
  createInMemoryWriter,
  type InMemoryWriter,
} from '../../../__tests__/fixtures/in-memory-writer.js';

interface Demo {
  readonly name: string;
  readonly count: number;
}

const demoTable: TableFormat<Demo> = {
  headers: ['name', 'count'],
  row: (d) => [d.name, String(d.count)],
};

describe('createRenderer — JSON success rendering', () => {
  let stdout: InMemoryWriter;

  beforeEach(() => {
    stdout = createInMemoryWriter();
  });

  // T1
  it('writes a compact JSON success envelope terminated by exactly one newline', () => {
    const renderer = createRenderer<Demo>({
      output: 'json',
      stdout: stdout.writer,
      color: false,
      table: demoTable,
    });

    const data: Demo = { name: 'alpha', count: 3 };
    renderer.render(data);

    const out = stdout.toString();
    expect(out.endsWith('\n')).toBe(true);

    const trimmed = out.slice(0, -1);
    const parsed = JSON.parse(trimmed) as unknown;
    expect(parsed).toEqual({ ok: true, data, exitCode: 0 });
  });

  // T2
  it('produces JSON in compact form: no inner newlines, no key whitespace', () => {
    const renderer = createRenderer<Demo>({
      output: 'json',
      stdout: stdout.writer,
      color: false,
      table: demoTable,
    });

    renderer.render({ name: 'alpha', count: 3 });

    const out = stdout.toString();
    // exactly one '\n', and it must be the trailing byte
    const newlineCount = (out.match(/\n/g) ?? []).length;
    expect(newlineCount).toBe(1);
    expect(out.indexOf('\n')).toBe(out.length - 1);

    // no whitespace padding inside the JSON body (no pretty-printing)
    const body = out.slice(0, -1);
    expect(body).not.toMatch(/[:,]\s/);
    expect(body).not.toMatch(/\s[:,]/);
  });
});

describe('createRenderer — table success rendering', () => {
  let stdout: InMemoryWriter;

  beforeEach(() => {
    stdout = createInMemoryWriter();
  });

  // T3
  it('writes a cli-table3 rendering containing all headers and row values', () => {
    const renderer = createRenderer<Demo>({
      output: 'table',
      stdout: stdout.writer,
      color: false,
      table: demoTable,
    });

    renderer.render({ name: 'alpha', count: 3 });

    const out = stdout.toString();
    // every header label appears
    for (const header of demoTable.headers) {
      expect(out).toContain(header);
    }
    // every row cell appears
    for (const cell of demoTable.row({ name: 'alpha', count: 3 })) {
      expect(out).toContain(cell);
    }
    // table output is terminated by a newline
    expect(out.endsWith('\n')).toBe(true);
  });

  // T4
  it('emits at least one ANSI escape when color:true', () => {
    const renderer = createRenderer<Demo>({
      output: 'table',
      stdout: stdout.writer,
      color: true,
      table: demoTable,
    });

    renderer.render({ name: 'alpha', count: 3 });

    // Don't pin specific codes — chalk versions vary. Just check for any CSI prefix.
    expect(stdout.toString()).toMatch(/\x1b\[/);
  });

  // T5
  it('emits no ANSI escapes when color:false', () => {
    const renderer = createRenderer<Demo>({
      output: 'table',
      stdout: stdout.writer,
      color: false,
      table: demoTable,
    });

    renderer.render({ name: 'alpha', count: 3 });

    expect(stdout.toString()).not.toMatch(/\x1b\[/);
  });
});

describe('createRenderer — JSON error envelope', () => {
  let stdout: InMemoryWriter;

  function jsonRenderer(): ReturnType<typeof createRenderer<Demo>> {
    return createRenderer<Demo>({
      output: 'json',
      stdout: stdout.writer,
      color: false,
      table: demoTable,
    });
  }

  beforeEach(() => {
    stdout = createInMemoryWriter();
  });

  // T6
  it('renders NotFoundError as code:NOT_FOUND, exitCode:3', () => {
    jsonRenderer().renderError(new NotFoundError('index', 'foo'));

    const parsed = JSON.parse(stdout.toString().slice(0, -1)) as unknown;
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'index not found: foo' },
      exitCode: 3,
    });
  });

  // T7
  it('renders UsageError as code:USAGE, exitCode:2', () => {
    jsonRenderer().renderError(new UsageError('bad'));

    const parsed = JSON.parse(stdout.toString().slice(0, -1)) as unknown;
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'USAGE', message: 'bad' },
      exitCode: 2,
    });
  });

  // T8: the base CliError tokenizes to a single token after the _ERROR strip.
  it('renders base CliError as code:CLI with caller-supplied exitCode', () => {
    jsonRenderer().renderError(new CliError('x', 7));

    const parsed = JSON.parse(stdout.toString().slice(0, -1)) as unknown;
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'CLI', message: 'x' },
      exitCode: 7,
    });
  });

  // T9: non-CliError errors are hard-coded INTERNAL / exitCode:1; D7 rule is not applied.
  it('renders a non-CliError as code:INTERNAL, exitCode:1', () => {
    jsonRenderer().renderError(new Error('boom'));

    const parsed = JSON.parse(stdout.toString().slice(0, -1)) as unknown;
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'boom' },
      exitCode: 1,
    });
  });
});

describe('createRenderer — table-mode errors', () => {
  let stdout: InMemoryWriter;

  function tableRenderer(): ReturnType<typeof createRenderer<Demo>> {
    return createRenderer<Demo>({
      output: 'table',
      stdout: stdout.writer,
      color: false,
      table: demoTable,
    });
  }

  beforeEach(() => {
    stdout = createInMemoryWriter();
  });

  // T10
  it('writes "error [NOT_FOUND]: <msg>\\n" on stdout for a NotFoundError', () => {
    tableRenderer().renderError(new NotFoundError('index', 'foo'));

    const out = stdout.toString();
    expect(out).toBe('error [NOT_FOUND]: index not found: foo\n');
    expect(out).not.toMatch(/\x1b\[/);
  });

  // T10b
  it('writes "error [INTERNAL]: <msg>\\n" on stdout for a non-CliError', () => {
    tableRenderer().renderError(new Error('boom'));

    expect(stdout.toString()).toBe('error [INTERNAL]: boom\n');
  });
});

describe('createRenderer — boundary invariants', () => {
  let stdout: InMemoryWriter;
  let stderr: InMemoryWriter;

  beforeEach(() => {
    stdout = createInMemoryWriter();
    stderr = createInMemoryWriter();
  });

  // T11
  it('never writes to stderr in either render or renderError', () => {
    for (const output of ['json', 'table'] as const) {
      const r = createRenderer<Demo>({
        output,
        stdout: stdout.writer,
        color: false,
        table: demoTable,
      });
      r.render({ name: 'alpha', count: 3 });
      r.renderError(new NotFoundError('index', 'foo'));
      r.renderError(new Error('boom'));
    }

    expect(stderr.toString()).toBe('');
  });
});

describe('createRenderer — D15 env-independence', () => {
  let stdout: InMemoryWriter;

  beforeEach(() => {
    stdout = createInMemoryWriter();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // T12 (a): static check — renderer.ts source must not reference process.*
  it('source contains no `process.` references and no node:process import', () => {
    const rendererSrcPath = fileURLToPath(new URL('../renderer.ts', import.meta.url));
    const src = readFileSync(rendererSrcPath, 'utf8');

    expect(src).not.toMatch(/\bprocess\./);
    expect(src).not.toMatch(/from\s+['"](?:node:)?process['"]/);
  });

  // T12 (b): runtime check — NO_COLOR has no effect on the renderer's output.
  it('color:true emits ANSI even with NO_COLOR=1 set', () => {
    vi.stubEnv('NO_COLOR', '1');
    const r = createRenderer<Demo>({
      output: 'table',
      stdout: stdout.writer,
      color: true,
      table: demoTable,
    });
    r.render({ name: 'alpha', count: 3 });

    expect(stdout.toString()).toMatch(/\x1b\[/);
  });

  it('color:false emits no ANSI even with NO_COLOR unset', () => {
    vi.stubEnv('NO_COLOR', '');
    const r = createRenderer<Demo>({
      output: 'table',
      stdout: stdout.writer,
      color: false,
      table: demoTable,
    });
    r.render({ name: 'alpha', count: 3 });

    expect(stdout.toString()).not.toMatch(/\x1b\[/);
  });
});
