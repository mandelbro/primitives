import { Command } from 'commander';
import type { Index, IndexClient } from '../../__tests__/fixtures/index-client.js';
import { CliError } from '../../lib/cli-output/errors.js';
import {
  createRenderer,
  type OutputFormat,
  type TableFormat,
} from '../../lib/cli-output/renderer.js';

export interface GetCommandDeps {
  readonly client: IndexClient;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  readonly noColor: boolean;
  readonly signal: AbortSignal;
  readonly resolveOutput: () => OutputFormat | undefined;
}

const INDEX_TABLE: TableFormat<Index> = {
  headers: ['name', 'status', 'dimension', 'metric', 'replicas', 'createdAt'],
  row: (i) => [
    i.name,
    i.status,
    String(i.dimension),
    i.metric,
    String(i.replicas),
    i.createdAt,
  ],
};

export function createGetCommand(deps: GetCommandDeps): Command {
  return new Command('get')
    .description('get an index by name')
    .argument('<name>', 'index name')
    .action(async (name: string) => {
      const fallback: OutputFormat = deps.isTTY ? 'table' : 'json';
      const resolved = deps.resolveOutput();
      const format: OutputFormat = resolved ?? fallback;
      const color = !deps.noColor && deps.isTTY && format === 'table';
      const renderer = createRenderer<Index>({
        output: format,
        stdout: deps.stdout,
        color,
        table: INDEX_TABLE,
      });
      try {
        const result = await deps.client.getIndex(name, deps.signal);
        renderer.render(result);
      } catch (err) {
        const e = err as Error;
        renderer.renderError(e);
        process.exitCode = e instanceof CliError ? e.exitCode : 1;
      }
    });
}
