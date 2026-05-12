#!/usr/bin/env node
import { Command } from 'commander';
import { CliError } from '../src/lib/cli-output/errors.js';

// Round deliverable: once the candidate implements
// `src/commands/index/get.ts`, uncomment the import and the
// `program.addCommand(...)` line in `main()` below.
//
// import { createGetCommand } from '../src/commands/index/get.js';
// import { createFakeIndexClient, DEFAULT_INDEX } from '../src/__tests__/fixtures/index-client.js';

interface BinDependencies {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  isTTY: boolean;
  noColor: boolean;
  signal: AbortSignal;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  process.on('SIGINT', () => {
    controller.abort();
  });

  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  });

  const deps: BinDependencies = {
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdout.isTTY),
    noColor: Boolean(process.env['NO_COLOR']),
    signal: controller.signal,
  };

  const program = new Command()
    .name('pcsk')
    .description('Pinecone developer CLI')
    .version('0.0.0');

  // Round deliverable — attach subcommands here once implemented:
  //
  //   program.addCommand(createGetCommand({
  //     ...deps,
  //     client: createFakeIndexClient({ index: DEFAULT_INDEX }),
  //   }));
  void deps;

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    const e = err as Error;
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}

void main();
