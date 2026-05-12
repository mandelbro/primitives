import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { createRenderer, type TableFormat } from '../renderer.js';

interface InMemoryWriter {
  readonly writer: NodeJS.WritableStream;
  toString(): string;
}

function createInMemoryWriter(): InMemoryWriter {
  const chunks: Buffer[] = [];
  const writer = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return {
    writer,
    toString(): string {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

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
