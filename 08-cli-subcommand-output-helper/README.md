# 08 — CLI Subcommand Output Helper

A TypeScript developer-CLI primitive: a reusable `cli-output` helper plus
the first subcommand (`pcsk index get <name>`) that consumes it. Designed
as a 35-minute live-coding exercise where the candidate is handed a
working scaffold and asked to build the helper and its first consumer.

## State

This primitive is in **scaffold-only** state. The candidate's deliverables
are intentionally absent — implementing them is the round.

### Already in the scaffold

| File | Role |
|---|---|
| `bin/pcsk.ts` | Entrypoint. Wires `process.stdout`/`stderr`/`isTTY`/`NO_COLOR`, creates an `AbortController` bound to `SIGINT`, installs an `EPIPE` handler that exits 0, and maps `err instanceof CliError ? err.exitCode : 1`. |
| `src/lib/cli-output/errors.ts` | `CliError` (base, with `exitCode`), `NotFoundError` (3), `UsageError` (2). |
| `src/__tests__/fixtures/index-client.ts` | Fake `IndexClient`. Configurable to resolve with a fixture, throw `NotFoundError`, throw a generic error, or hang until an `AbortSignal` fires. |

### Round deliverables (not yet implemented)

| File | Role |
|---|---|
| `src/lib/cli-output/renderer.ts` | The `createRenderer<T>` factory. |
| `src/lib/cli-output/__tests__/renderer.test.ts` | Helper tests in isolation. |
| `src/commands/index/get.ts` | The `pcsk index get` subcommand factory. |
| `src/commands/index/__tests__/get.test.ts` | Subcommand tests composing the helper. |

Consumers import directly from the leaf files (`./renderer.js`,
`./errors.js`) — no barrel `index.ts`. The directory `src/lib/cli-output/`
is the boundary; `grep` is the enforcement mechanism. A barrel would
add tree-shaking blind spots, vitest slowness, and circular-dependency
risk in exchange for cosmetic single-import-path savings that aren't
needed at one consumer.

When the candidate finishes `get.ts`, they uncomment two lines in
`bin/pcsk.ts` to wire the subcommand into the root program.

## Read first

[`cli-subcommand-output-helper-spec.md`](./cli-subcommand-output-helper-spec.md)
— public API, design decisions, error states, test plan, out of scope.

## Why a scaffold instead of a finished primitive

The other primitives in this directory are showcases of completed work.
This one is a showcase of the *starting point* of a deliberate
35-minute round. The interesting parts — output discipline encoded in
API shape, schema-as-gate, dependency-injected writers, exit-code
carve-out — are what the candidate produces *on top of* this scaffold.
Reading the scaffold is itself a study in what staff-level CLI
plumbing looks like before any feature code touches it.

## Commands

```bash
pnpm install
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test
```

`pnpm check` passes on the scaffold alone (the error class hierarchy
has a test). It will keep passing as the candidate adds their work
provided they honor the boundaries.
