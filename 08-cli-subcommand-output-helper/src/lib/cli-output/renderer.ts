import { Chalk } from 'chalk';
import Table from 'cli-table3';
import { CliError } from './errors.js';

export type OutputFormat = 'table' | 'json';

export interface TableFormat<T> {
  readonly headers: readonly string[];
  readonly row: (item: T) => readonly string[];
}

export interface RendererOptions<T> {
  readonly output: OutputFormat;
  readonly stdout: NodeJS.WritableStream;
  readonly color: boolean;
  readonly table: TableFormat<T>;
}

export interface EnvelopeError {
  readonly code: string;
  readonly message: string;
}

export type Envelope<T> =
  | { readonly ok: true; readonly data: T; readonly exitCode: 0 }
  | { readonly ok: false; readonly error: EnvelopeError; readonly exitCode: number };

export interface Renderer<T> {
  render(data: T): void;
  renderError(err: Error): void;
}

/**
 * Per spec §D7: PascalCase → SCREAMING_SNAKE → strip trailing _ERROR
 * iff at least one character precedes the underscore. Applied only to
 * CliError subclass names; non-CliError errors are hard-coded INTERNAL/1.
 */
function classifyError(err: Error): { code: string; exitCode: number } {
  if (!(err instanceof CliError)) {
    return { code: 'INTERNAL', exitCode: 1 };
  }
  const snake = err.name.replace(/(?<!^)[A-Z]/g, '_$&').toUpperCase();
  const suffix = '_ERROR';
  const code =
    snake.endsWith(suffix) && snake.length > suffix.length
      ? snake.slice(0, -suffix.length)
      : snake;
  return { code, exitCode: err.exitCode };
}

export function createRenderer<T>(opts: RendererOptions<T>): Renderer<T> {
  return {
    render(data: T): void {
      if (opts.output === 'json') {
        const envelope: Envelope<T> = { ok: true, data, exitCode: 0 };
        opts.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      }
      const c = new Chalk({ level: opts.color ? 3 : 0 });
      const head = opts.table.headers.map((h) => c.bold(h));
      const table = new Table({
        head,
        style: { head: [], border: [] },
      });
      table.push([...opts.table.row(data)]);
      opts.stdout.write(table.toString() + '\n');
    },
    renderError(err: Error): void {
      const { code, exitCode } = classifyError(err);
      if (opts.output === 'json') {
        const envelope: Envelope<T> = {
          ok: false,
          error: { code, message: err.message },
          exitCode,
        };
        opts.stdout.write(JSON.stringify(envelope) + '\n');
        return;
      }
      throw new Error('table-mode renderError not yet implemented');
    },
  };
}
