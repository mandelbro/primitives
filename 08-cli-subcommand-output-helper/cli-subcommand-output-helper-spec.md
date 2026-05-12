# CLI Subcommand Output Helper + First Subcommand (`pcsk index get`)

## What is it?

A TypeScript developer-CLI primitive: a reusable `cli-output` helper that can be consumed by subcommands. The helper is responsible for formatting the output of the subcommand for two audiences:

1. Humans at terminals running interactive sessions.
2. Scripts or AI agents calling the CLI as a subprocess.

The helper automatically detects the audience and formats the output accordingly.

For humans, the output is formatted as a table with ANSI color.

For scripts and agents, the output is formatted as JSON wrapped in a result envelope so the consumer can branch on success vs. failure without parsing free-form text.

In addition to the auto-detection, the helper supports an explicit `--output` flag that allows the user to override the default output format.

Usage pattern: Users should import a helper, declare their data shape, and provide a text formatter. The helper does the rest.

This helper is consumed by the `pcsk index get <name>` subcommand to demonstrate the implementation pattern. The subcommand resolves an `Index` resource through an injected `IndexClient` (a fake implementation is provided under `src/__tests__/fixtures/index-client.ts`) and hands the resolved record to the helper for rendering.

### How this fits into the existing CLI scaffold

The scaffold establishes the **boundary** at which output decisions are made: `bin/pcsk.ts` already resolves the four facts a renderer needs — `stdout`, `stderr`, `stdout.isTTY`, and `NO_COLOR` — from the process at startup and bundles them into a `BinDependencies` object. It also installs the `EPIPE → exit 0` handler, the `SIGINT → AbortController.abort()` plumbing, and the `err instanceof CliError ? err.exitCode : 1` mapping. The renderer is the consumer of those facts, not their resolver. It never reads `process.*` directly.

`src/lib/cli-output/errors.ts` provides the error vocabulary the renderer translates into the JSON envelope's `error.code` field. `CliError.name` is the source of truth for the code string; `NotFoundError` → `NOT_FOUND`, `UsageError` → `USAGE`, the base `CliError` → `CLI`, anything else → `INTERNAL`. No `code` field is added to the error class — the convention is one-way derivation at render time. Per D7, all `CliError` subclass names must follow plain PascalCase (no acronyms); this is the simplification that lets the tokenizer be three lines instead of a smart-camelCase library.

The fake `IndexClient` in `src/__tests__/fixtures/index-client.ts` is the seam that lets the subcommand's tests exercise the full happy path, not-found path, generic-error path, and cancellation path without a network. It's deliberately structured as a constructor returning an object literal so each test can build a client tailored to one scenario.

The candidate's two deliverable directories slot in beneath this scaffold with three permitted modifications and no others:

1. Uncomment the two wiring lines in `bin/pcsk.ts` (the `import` and the `program.addCommand(...)` call).
2. Declare the global `--output <format>` flag on the root `program` in `bin/pcsk.ts`.
3. Rename the scaffold's `CLIError` class to `CliError` in `src/lib/cli-output/errors.ts` (and the corresponding import + `instanceof` in `bin/pcsk.ts`). This is the deliberate concession made by D7 — the simpler tokenizer requires acronym-free PascalCase, and the scaffold's only acronym-named class is the base error itself.

Then:

- `src/lib/cli-output/renderer.ts` — the `createRenderer<T>` factory, importing only from `./errors.js`, `chalk`, and `cli-table3`.
- `src/commands/index/get.ts` — the `createGetCommand({ client, ...deps, output })` factory that builds a Commander `Command`, declares the `<name>` argument, and in its action handler instantiates a renderer per-invocation and dispatches to `client.getIndex(name, signal)`.

The directory `src/lib/cli-output/` is the boundary. There is no barrel `index.ts`; consumers import leaf files. `grep` enforces the boundary — if `process.stdout` appears anywhere under `src/lib/cli-output/`, the boundary has been violated.

## Public API

All exports are from leaf files. No `index.ts` barrel.

### `src/lib/cli-output/renderer.ts`

```ts
import type { CliError } from './errors.js';

/**
 * The format the renderer will produce. Resolved from `--output` if
 * provided, otherwise auto-detected: `isTTY === true` → `'table'`, else
 * `'json'`. Never resolved inside the renderer — the caller passes the
 * resolved value at factory time.
 */
export type OutputFormat = 'table' | 'json';

/**
 * Caller-supplied table description. The renderer uses these to build a
 * `cli-table3` instance for the `'table'` format. Headers are rendered
 * once at the top; `row(item)` is invoked once per item.
 *
 * For a single-item render (the `pcsk index get` shape), call with one
 * row. The contract scales to lists if a future subcommand needs them.
 */
export interface TableFormat<T> {
  readonly headers: readonly string[];
  readonly row: (item: T) => readonly string[];
}

export interface RendererOptions<T> {
  /** The resolved output format. Caller decides; renderer obeys. */
  readonly output: OutputFormat;
  /** Stream the renderer writes both success and failure to. */
  readonly stdout: NodeJS.WritableStream;
  /**
   * Whether ANSI color is permitted in `'table'` output. The single
   * authoritative signal the renderer reads — see D15. Caller resolves
   * this from `!noColor && isTTY` (or any other policy: a `--no-color`
   * flag, a config file, an override). The renderer does **not** read
   * `process.env.NO_COLOR` or any other environment variable; chalk's
   * built-in env detection is explicitly disabled (D15). Ignored in
   * `'json'` mode.
   */
  readonly color: boolean;
  /** Caller-supplied table description. Used only in `'table'` mode. */
  readonly table: TableFormat<T>;
}

/**
 * Result envelope written to stdout in `'json'` mode. The discriminator
 * is `ok`. `exitCode` mirrors the process exit code the CLI will return
 * — it is included in the envelope as a courtesy to JSON consumers that
 * can't easily observe the process exit (some agent harnesses).
 */
export type Envelope<T> =
  | { readonly ok: true;  readonly data: T;       readonly exitCode: 0 }
  | { readonly ok: false; readonly error: EnvelopeError; readonly exitCode: number };

export interface EnvelopeError {
  /** Derived from `CliError.name` → SCREAMING_SNAKE. See spec §Error States. */
  readonly code: string;
  readonly message: string;
}

export interface Renderer<T> {
  /**
   * Render a successful result.
   *
   * - `'table'` mode: writes the rendered table to `stdout`, with a
   *   trailing newline. Colored iff `color === true`.
   * - `'json'` mode: writes `JSON.stringify({ok:true, data, exitCode:0})`
   *   followed by a single newline to `stdout`. No coloring, no whitespace
   *   indentation (compact form for piping).
   */
  render(data: T): void;

  /**
   * Render a failure. Always writes to `stdout` in `'json'` mode (a
   * single stream for the JSON consumer); writes a one-line `error: …`
   * to `stdout` in `'table'` mode for visual continuity (the bin layer
   * has already written to `stderr` if it caught the error before
   * reaching the renderer; the renderer is for in-handler errors).
   *
   * The caller is responsible for setting the process exit code via
   * the thrown `CliError` — the renderer does not call `process.exit`.
   *
   * Non-`CliError` errors are rendered with `code: 'INTERNAL'` and
   * `exitCode: 1`.
   */
  renderError(err: Error): void;
}

export function createRenderer<T>(opts: RendererOptions<T>): Renderer<T>;
```

### `src/commands/index/get.ts`

```ts
import type { Command } from 'commander';
import type { IndexClient } from '../../__tests__/fixtures/index-client.js';
import type { OutputFormat } from '../../lib/cli-output/renderer.js';

export interface GetCommandDeps {
  readonly client: IndexClient;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  readonly noColor: boolean;
  readonly signal: AbortSignal;
  /**
   * Resolver for the `--output` flag, evaluated lazily inside the
   * action handler. Lazy because Commander parses global options after
   * subcommand construction; the resolver closes over `program.opts()`.
   */
  readonly resolveOutput: () => OutputFormat | undefined;
}

/**
 * Builds the `index get <name>` Commander subcommand. The returned
 * `Command` is mounted via `program.addCommand(...)` in `bin/pcsk.ts`.
 *
 * The action handler:
 *   1. Computes the *fallback* format from auto-detection alone:
 *      `fallback = isTTY ? 'table' : 'json'`. This is the format the
 *      renderer falls back to when `--output` is malformed (step 2)
 *      and the format used when `--output` is omitted (step 3).
 *   2. Reads `resolveOutput()`. If the value is neither `undefined`,
 *      `'table'`, nor `'json'`, treats it as a user-facing usage error:
 *      builds a renderer using `fallback`, calls
 *      `renderer.renderError(new UsageError('invalid --output: <value>'))`,
 *      sets `process.exitCode = 2`, returns. See D14. (Note: validation
 *      happens *before* the happy-path renderer is built, so the
 *      malformed format value never reaches `createRenderer`.)
 *   3. Otherwise, resolves the format: `resolveOutput() ?? fallback`.
 *      Builds the happy-path renderer with the resolved format, the
 *      injected writers, and a hand-written `TableFormat<Index>`
 *      describing the columns.
 *   4. Calls `client.getIndex(name, signal)` and renders the success.
 *   5. If the thrown error is an `AbortError` (i.e., `err.name ===
 *      'AbortError'`), the action handler intercepts it *before* the
 *      renderer dispatch: sets `process.exitCode = 130` (Unix SIGINT
 *      convention) and returns. No output is written. See D13.
 *   6. For any other thrown error, calls `renderer.renderError` and
 *      sets `process.exitCode` (`err.exitCode` if `err instanceof
 *      CliError`, else `1`). Returns normally — does not re-throw. This
 *      prevents bin's top-level `catch` from writing `error: ${msg}` to
 *      `stderr`, which would corrupt the JSON-mode contract (stderr must
 *      stay empty in `'json'` mode). See D6.
 */
export function createGetCommand(deps: GetCommandDeps): Command;
```

### Wiring change in `bin/pcsk.ts`

Two changes:

1. Declare the global `--output <format>` option on `program` with `.option('--output <format>', 'output format: table | json')`.
2. Uncomment the import and `program.addCommand(...)` lines; pass `resolveOutput: () => program.opts()['output']`.

No other scaffold edits.

## Design Decisions

Each decision below is a *choice that had defensible alternatives*. The rationale is the reason a future reader should not silently flip it.

### D1. Auto-detection signal is `stdout.isTTY` only

Not `stderr.isTTY`, not `CI`, not `NO_COLOR`. **Why**: the renderer is making one decision — "am I being piped or read by a human?" — and the answer is encoded directly in `stdout`'s TTY status. Pipes, redirects, and `parseAsync` invocations in tests all surface as `isTTY === false`, which is exactly what the JSON-consumer path wants. `NO_COLOR` is orthogonal: it controls *color within the table format*, never the choice of format itself. Conflating the two would make `NO_COLOR=1 pcsk index get demo` silently switch to JSON, which is surprising. **Alternative considered**: tiered detection that also checks `CI`. Rejected because the user can always be explicit with `--output json` in CI, and tiered rules are harder to grep-for.

### D2. Format vocabulary names the encoding, not the audience

`--output table | json`. **Why**: encoding-named flags are honest — `table` produces a table, `json` produces JSON. Audience-named flags (`--output human | machine`) hide what's on the wire and make a future `yaml` addition a breaking rename. The cost is that adding `yaml` later still requires a code change in any subcommand's `TableFormat<T>`-vs-serializer logic — which is fine, that's a deliberate decision per-format.

### D3. Format resolution lives in the caller, not the renderer

`createRenderer({ output, ... })` takes a resolved `OutputFormat`. The subcommand's action handler does `resolveOutput() ?? (isTTY ? 'table' : 'json')`. **Why**: the renderer is then a pure function of its inputs — no env, no Commander, no `process.*`. The decision logic is testable independently (subcommand tests assert "given `--output=json` and `isTTY=true`, the renderer was built with `output: 'json'`"), and the renderer tests don't have to mock TTY state. **Alternative considered**: renderer reads `isTTY` and `output` directly and decides. Rejected because it pushes Commander/process coupling one layer deeper.

### D4. Envelope shape is `{ok, data?, error?, exitCode}` discriminated on `ok`

Same discriminated-union pattern as `01-rate-limiter`. `exitCode` is mirrored inside the envelope as a courtesy to agent harnesses that can't easily observe the process exit code (some MCP-like wrappers, certain CI runners). **Why include `exitCode` redundantly**: zero cost to the producer, real cost saved by some consumers. The process exit is still the canonical signal. **Why discriminate on `ok` not presence-of-`data`/`error`**: a single boolean discriminator is greppable in consumer code and unambiguous in TypeScript's narrowing.

### D5. JSON output is compact and goes only to stdout

No pretty-printing (use `| jq .`), no whitespace between keys, trailing single `\n`. Stderr stays *empty* in JSON mode — the entire conversation with a JSON consumer happens over one stream. **Why**: a JSON consumer that reads both streams to "collect everything" gets corrupted output when human-readable messages leak to stderr; restricting JSON mode to one stream makes that impossible.

### D6. In-handler errors are rendered to stdout in both formats; bin's `catch` is reserved for setup errors

The subcommand's action handler catches *every* error from the client, calls `renderer.renderError`, and sets `process.exitCode`. It does **not** re-throw. **Why**: bin's `catch` block (which we cannot modify per scaffold policy) unconditionally writes `error: ${msg}\n` to `stderr` and calls `process.exit`. In JSON mode that violates D5 (stderr must be empty). In table mode it would double-print the error (renderer line + bin line). Catching in the action handler and letting `parseAsync` resolve normally avoids both. Bin's `catch` therefore now only fires for errors thrown *before* the action handler runs (Commander parse failures, programmer wiring bugs) — which is the correct shape: bin handles framework errors, the action handler handles command errors.

A consequence worth flagging: in table mode, `error: …` lines appear on **stdout**, not stderr. This breaks Unix convention. We accept the break in exchange for a clean single-stream model and to keep bin's `catch` block untouched (the scaffold permits the `CliError` rename per §1 D7, but no other modifications to bin's logic). If a real CLI needed strict stderr separation, the renderer would accept a separate `stderr` writer and route accordingly — a one-line extension.

### D7. Error code derivation: PascalCase tokenizer + always-strip `_ERROR`

The renderer applies this rule to `err.name` for any `err instanceof CliError`:

1. Insert `_` before each non-leading uppercase letter.
2. Uppercase the entire string.
3. If the result ends in `_ERROR` AND at least one character precedes the `_`, drop the trailing `_ERROR`.

Worked examples:

| `err.name` | After step 1 | After step 2 | After step 3 | Code |
|---|---|---|---|---|
| `NotFoundError` | `Not_Found_Error` | `NOT_FOUND_ERROR` | `NOT_FOUND` | `NOT_FOUND` |
| `UsageError` | `Usage_Error` | `USAGE_ERROR` | `USAGE` | `USAGE` |
| `CliError` | `Cli_Error` | `CLI_ERROR` | `CLI` | `CLI` |

For any error not a `CliError` subclass (including plain `Error`), the code is hard-coded to `'INTERNAL'` and `exitCode` to `1`. The rule above is never applied to non-`CliError` errors.

**Naming constraint on `CliError` subclasses**: names must be plain PascalCase — each capital letter starts a new word, no consecutive uppercase letters (other than the single leading capital). A subclass named `HTTPError` would tokenize to `H_T_T_P` and produce a meaningless code; that's the user's problem. This is a convention, not a runtime check. The scaffold's `CliError` (renamed from `CLIError` — see §1) is the only base case; all subclasses (`NotFoundError`, `UsageError`) already comply.

**Why this rule (B from the Zod review)**: the smart-camelCase alternative (lodash `_.snakeCase` semantics with acronym handling) is ~15 lines and a non-trivial test matrix. The dumb-PascalCase rule above is three lines of `String.prototype.replace` + `toUpperCase` + `endsWith`. The simplification has one cost — the scaffold rename of `CLIError → CliError` — which is acceptable because the base class was the only acronym-named class in the scaffold.

**Why convention over explicit field**: the rule is testable in one place (renderer); adding a new acronym-free error subclass automatically participates without registering a code or touching the renderer.

### D8. Renderer is constructor-time DI, per-invocation in the subcommand

Same pattern as `01-rate-limiter`'s clock and `06-jwt-jwks`'s `now`/`fetcher`. Each subcommand action handler builds a renderer with the format and writers resolved at the moment of invocation, uses it, and discards it. **Why per-invocation**: format and color decisions depend on flag parsing, which Commander completes only when `parseAsync` runs. Hoisting the renderer to module load would force premature resolution.

### D9. `--output` is a global flag on `program`

Declared once on the root Commander instance; subcommands read it via a closure (`resolveOutput: () => program.opts()['output']`). **Why global**: the format choice is a CLI-wide concern, not a per-subcommand opinion. Declaring it once means a future `pcsk index list` reads from the same source with zero plumbing. **Why a resolver closure rather than passing the resolved value**: Commander parses global options *after* subcommands are constructed but *before* their action handlers run. A closure is the minimal indirection that bridges that ordering.

### D10. Caller owns `TableFormat<T>`; helper drives `cli-table3`

`TableFormat<T>` is `{ headers, row(item) }`. The renderer instantiates `cli-table3`, sets `head`, pushes one row, and writes the result. **Why caller-owned**: the renderer doesn't know about `Index`'s fields; pushing column knowledge into the renderer would couple it to every consumer. **Why structured (not `format: (item) => string`)**: with `cli-table3` already in play, the helper can deliver borders, alignment, and color uniformly across all consumers. A bare-string formatter would push that complexity per-consumer.

### D11. `chalk` and `cli-table3` are direct dependencies, no abstraction layer

Imported directly from `renderer.ts`. **Why no wrapper**: a thin "table util" module would be one indirection layer protecting against a substitution we have no plan to make. If we ever swap `cli-table3` for a hand-rolled formatter, that's a localized refactor in `renderer.ts`. Color behavior is governed by D15, not by either library's defaults.

### D12. Renderer never touches `process.*`; subcommand handlers may set `process.exitCode` but never call `process.exit`

Two boundary rules enforced by static check:

1. **Renderer (`src/lib/cli-output/`)**: no `process.exit`, no `process.stderr`, no `process.env`. All inputs are constructor-time DI. Enforced by `grep -r 'process\.' src/lib/cli-output/` returning zero matches (T12 codifies this).
2. **Subcommand action handlers (`src/commands/`)**: may *set* `process.exitCode` (the property assignment is the standard Node idiom for declaring an exit code without immediately terminating); must *not* call `process.exit(...)` (the function call short-circuits the event loop and makes tests unreliable). Enforced by `grep 'process\.exit(' src/commands/` returning zero matches — note the trailing `(` distinguishes the function call from the property assignment (G-T9 codifies this).

Bin (`bin/pcsk.ts`) is the only file in the project that calls `process.exit` directly. That call is in the scaffold and is not modified by the candidate.

### D13. `AbortError` is intercepted by the action handler and produces no output

When `client.getIndex` rejects with an error whose `name === 'AbortError'`, the subcommand action handler short-circuits *before* the renderer is invoked, sets `process.exitCode = 130` (the conventional Unix exit code for `SIGINT`), and returns. Stdout and stderr stay untouched. **Why**: Ctrl-C is a user-initiated termination, not an error to be reported. Reporting it via an envelope or a stderr line would be noise — the user already knows they aborted, and a JSON consumer that lost its sub-process to SIGINT has the exit code as the canonical signal. **What this excludes**: a structured `ABORTED` envelope for JSON consumers that observe only stdout (deferred — see §Out of Scope). The renderer itself remains ignorant of cancellation; no `AbortError` branch lives in `renderer.ts`. If a future iteration adds the envelope, it does so by removing this intercept and adding a name-check in the renderer, not by extending the action handler.

### D14. `--output` validation lives in the action handler, not in Commander

Commander supports `.choices(['table', 'json'])` for built-in enum validation. We deliberately do not use it. **Why**: Commander's failure path writes to `process.stderr` and either returns a non-zero exit through its own mechanism or throws into bin's catch — both routes corrupt the D5 invariant that *stderr stays empty in `'json'` mode*. A JSON consumer who typos `--output=jjson` would receive a text error on stderr and exit 1, with no envelope on stdout. The action handler validates instead: it checks the resolved value against the closed set `{undefined, 'table', 'json'}`, and on mismatch builds a renderer using the auto-detected fallback format and surfaces the failure through `renderer.renderError` — the same envelope-or-line path as any other in-handler error. JSON consumers get an envelope; humans get a one-line message; both get exit code 2. **The fallback uses auto-detection, not the malformed value**, because the malformed value is not a valid `OutputFormat` and `createRenderer` would have undefined behavior with it.

The cost is six action-handler lines per subcommand. The benefit is one error pipeline, no Commander-vs-renderer split, and a testable G5/G-T12 path. If a future iteration adds many subcommands, this validation can be extracted into a shared helper (`resolveOutputOrFail(deps)`) — but not before three consumers exist.

### D15. `opts.color` is the only color signal; the renderer is environment-independent

`opts.color` is the single boolean the renderer reads to decide whether ANSI escapes appear in `'table'` output. The renderer **does not** read `process.env.NO_COLOR`, `process.env.FORCE_COLOR`, `process.stdout.isTTY`, or any other environmental signal. Two concrete enforcement points:

1. **Chalk env-detection is explicitly disabled.** Instead of using the default exported `chalk`, the renderer instantiates a scoped instance: `const c = new Chalk({ level: opts.color ? 3 : 0 })`. Level `0` disables all color regardless of environment; level `3` enables 24-bit color regardless of environment. (Chalk's default behavior auto-detects from env — that auto-detection happens at the module's first import, before `opts.color` is known, and is therefore unreliable as a renderer-level signal.)
2. **`cli-table3` border colors are suppressed via style options when `color:false`.** Pass `style: { head: [], border: [] }` to the `Table` constructor when `opts.color === false`. `cli-table3` defaults to colored borders via its own chalk usage; without this override, borders would leak color even when `opts.color === false`.

**Why caller-owned, not env-read**: matches D3 (resolution lives in the caller) and the broader pattern across this repo's primitives — `01-rate-limiter` injects the clock, `06-jwt-jwks` injects `fetcher` and `now`, this renderer injects `color`. Env coupling is a leak, and a leak in the renderer means tests have to coordinate `NO_COLOR` state with vitest's process — which is brittle and slow. With this rule, T4 (color:true → ANSI present) and T5 (color:false → no ANSI) hold regardless of the shell's env.

**What the caller is expected to do**: bin's `BinDependencies` already resolves `noColor = Boolean(process.env['NO_COLOR'])` and `isTTY = Boolean(process.stdout.isTTY)`. The subcommand's action handler computes `color = !noColor && isTTY && resolvedFormat === 'table'` and passes it in. (The `=== 'table'` factor is belt-and-suspenders; in JSON mode `color` is ignored, but pinning it to `false` keeps the value honest.)

## Error States

Enumerated by source. Each row specifies: trigger, what the renderer does, what the action handler does, observable result.

### Renderer (`createRenderer<T>`)

| ID | Trigger | Renderer behavior |
|---|---|---|
| **R1** | `render(data)` in `'json'` mode | Writes `JSON.stringify({ok:true, data, exitCode:0}) + '\n'` to `stdout`. |
| **R2** | `render(data)` in `'table'` mode | Builds a `cli-table3` from `headers` and one row; writes `table.toString() + '\n'` to `stdout`. Colored iff `color === true`. |
| **R3** | `renderError(err)` where `err instanceof CliError`, `'json'` mode | Writes envelope `{ok:false, error:{code: D7-rule(err.name), message: err.message}, exitCode: err.exitCode}` + `'\n'` to `stdout`. |
| **R4** | `renderError(err)` where `err` is any other `Error`, `'json'` mode | Writes `{ok:false, error:{code:'INTERNAL', message: err.message}, exitCode:1}` + `'\n'` to `stdout`. |
| **R5** | `renderError(err)`, `'table'` mode (any error type) | Writes `error [${code}]: ${err.message}\n` to `stdout`, where `code` is the D7-derived code for `CliError` subclasses (`NOT_FOUND`, `USAGE`, `CLI`) or `INTERNAL` for any other `Error`. No envelope. No color in v1 (the bracketed code may be colored red in a future iteration — see §Out of Scope). |
| **R6** | `format.row(item)` throws inside `render` | Not caught. Propagates to the action handler, which treats it as a generic error (R4 / R5 via `renderError`). |
| **R7** | `stdout.write` throws (e.g., `EPIPE`) | Not caught by the renderer. Bin's `process.stdout.on('error')` handler intercepts `EPIPE` and exits 0 process-wide. |
| **R8** | `renderError(err)` where `err` is not an `Error` instance (e.g., a thrown string) | Out of scope — see §Out of Scope. Action handler is responsible for normalizing thrown non-`Error` values into `Error` instances before invoking the renderer. |

### Subcommand (`pcsk index get <name>`)

| ID | Trigger | Action handler behavior | Observable result |
|---|---|---|---|
| **G1** | `<name>` argument missing | Not reached — Commander rejects in `parseAsync` before invoking the handler. | Commander prints its usage error to stderr, process exits 1 via bin's catch. |
| **G2** | `client.getIndex` throws `NotFoundError` | `renderer.renderError(err)`; `process.exitCode = 3`; return. | JSON: envelope `{ok:false, error:{code:'NOT_FOUND', message:'index not found: foo'}, exitCode:3}` on stdout. Table: `error [NOT_FOUND]: index not found: foo` on stdout. Process exits 3. |
| **G3** | `client.getIndex` throws an unrelated `Error` | `renderer.renderError(err)`; `process.exitCode = 1`; return. | JSON: envelope with `code:'INTERNAL'`, `exitCode:1`. Table: `error [INTERNAL]: ${msg}` on stdout. Process exits 1. |
| **G4** | `client.getIndex` rejects with `AbortError` (`err.name === 'AbortError'`) | Action handler intercepts *before* the renderer dispatch. Sets `process.exitCode = 130`. Returns. Does not call `render` or `renderError`. See D13. | Process exits 130. Stdout and stderr both empty. No envelope, no error line. |
| **G5** | `--output` provided with an invalid value (e.g., `--output=yaml`) | Action handler validates *before* the happy-path renderer is built. On mismatch with `{undefined, 'table', 'json'}`: constructs a fallback renderer using the auto-detected format (`isTTY ? 'table' : 'json'`), calls `renderer.renderError(new UsageError('invalid --output: yaml'))`, sets `process.exitCode = 2`, returns. `client.getIndex` is never called. See D14. | JSON consumer (`isTTY=false`): envelope `{ok:false, error:{code:'USAGE', message:'invalid --output: yaml'}, exitCode:2}` on stdout. Human (`isTTY=true`): `error [USAGE]: invalid --output: yaml` on stdout. Both: stderr empty, process exits 2. |
| **G6** | Internal renderer/library failure (e.g., `cli-table3` throws) | Escapes the try/catch in the action handler if it occurs *during* `render`/`renderError` themselves. Propagates to bin's catch. | Bin writes `error: ${msg}` to stderr, exit 1. This is a programmer bug, not a runtime contract. |

## Test Plan

Tests are atomic and behavior-focused, mapped to numbered IDs that the implementation tests will reference. Two files: helper-in-isolation, then subcommand-composing-the-helper.

### Renderer (`src/lib/cli-output/__tests__/renderer.test.ts`)

Each test builds a renderer with an in-memory writer (e.g., a custom `Writable` collecting `Buffer` chunks into a string) and asserts on the captured output.

| ID | Behavior |
|---|---|
| **T1** | `output:'json'`, `render(data)` writes a single-line, compact JSON envelope with `ok:true`, `data` deeply equal to input, `exitCode:0`, terminated by exactly one `\n`. |
| **T2** | `output:'json'`, JSON output is compact: contains no `\n` other than the trailing one, no leading whitespace in keys. |
| **T3** | `output:'table'`, `render(data)` writes a `cli-table3` rendering containing all `headers` and the values produced by `format.row(data)`. |
| **T4** | `output:'table'`, `color:true`: output contains at least one ANSI escape sequence (`\x1b[`). |
| **T5** | `output:'table'`, `color:false`: output contains no ANSI escape sequences. |
| **T6** | `output:'json'`, `renderError(new NotFoundError('index','foo'))` produces envelope with `error.code === 'NOT_FOUND'`, `error.message === 'index not found: foo'`, `exitCode:3`. |
| **T7** | `output:'json'`, `renderError(new UsageError('bad'))` → `error.code === 'USAGE'`, `exitCode:2`. |
| **T8** | `output:'json'`, `renderError(new CliError('x', 7))` → `error.code === 'CLI'`, `exitCode:7` (verifies D7's tokenizer applied to the base class, which strips to a single token). |
| **T9** | `output:'json'`, `renderError(new Error('boom'))` → `error.code === 'INTERNAL'`, `exitCode:1`. |
| **T10** | `output:'table'`, `renderError(new NotFoundError('index','foo'))` writes `error [NOT_FOUND]: index not found: foo\n` to stdout. No envelope, no `\x1b[` color. |
| **T10b** | `output:'table'`, `renderError(new Error('boom'))` writes `error [INTERNAL]: boom\n` to stdout. (Locks the non-`CliError` path in table mode — symmetric with T9 for JSON mode.) |
| **T11** | Renderer does not write to `stderr` in either mode. (Test injects a stderr writer; asserts it stayed empty across `render` and `renderError`.) |
| **T12** | Renderer is environment-independent per D15. Two assertions: (a) static check — the `renderer.ts` source contains no `process.` substring and no import of `process` / `node:process` (run via `fs.readFileSync` + regex in a vitest test, or as a `grep` step); (b) runtime check — using vitest's `vi.stubEnv`, set `process.env.NO_COLOR='1'`, build a renderer with `color:true`, call `render(data)`, assert the output contains `\x1b[`. Repeat with `process.env.NO_COLOR=''` and `color:false`, assert the output contains no `\x1b[`. The env stub is unset (`vi.unstubAllEnvs`) in an `afterEach`. |

### Subcommand (`src/commands/index/__tests__/get.test.ts`)

Each test composes `createGetCommand(deps)` with a fake `IndexClient`, an in-memory stdout, a stub `resolveOutput`, and a controlled `isTTY`. Tests invoke the command via `program.parseAsync(['node','pcsk','index','get','demo'])` or by calling the resulting `Command`'s `parseAsync` directly.

| ID | Behavior |
|---|---|
| **G-T1** | Happy path, `isTTY=false`, `resolveOutput()` returns `undefined`: emits JSON envelope `{ok:true, data: <DEFAULT_INDEX>, exitCode:0}`. (Asserts auto-detection chose JSON.) |
| **G-T2** | Happy path, `isTTY=true`, `resolveOutput()` returns `undefined`: emits a table containing `DEFAULT_INDEX.name` and the other field values. (Asserts auto-detection chose table.) |
| **G-T3** | Explicit override beats `isTTY`: `isTTY=true`, `resolveOutput()` returns `'json'` → JSON envelope on stdout, no table. |
| **G-T4** | Explicit override beats `isTTY`: `isTTY=false`, `resolveOutput()` returns `'table'` → table on stdout, no envelope. |
| **G-T5** | Not-found path, `output='json'`: fake client throws `NotFoundError`; envelope has `code:'NOT_FOUND'`, `exitCode:3`; `process.exitCode === 3` after `parseAsync` resolves. |
| **G-T6** | Not-found path, `output='table'`: `error [NOT_FOUND]: index not found: demo` on stdout, `process.exitCode === 3`. |
| **G-T7** | Generic error path, `output='json'`: fake client throws `new Error('boom')`; envelope `code:'INTERNAL'`, `exitCode:1`; `process.exitCode === 1`. |
| **G-T8** | Action handler never throws past `parseAsync` for client-originated errors. (Test wraps `parseAsync` in `try/catch` and asserts the catch never fires on G2/G3/G4 paths.) |
| **G-T9** | Action handler does not call `process.exit(...)`. Static check per D12 rule 2: a vitest test reads `src/commands/index/get.ts` via `fs.readFileSync`, asserts the file contents do not contain the substring `process.exit(` (trailing paren distinguishes the function call from the allowed `process.exitCode = ...` assignment). No globals are patched. |
| **G-T10** | Stderr stays empty across **every** subcommand test, regardless of `output` mode. Enforced via an `afterEach` hook in the subcommand test file: after each test, the hook reads the in-memory stderr writer used by the test and asserts `stderr.toString() === ''`. The hook is suite-wide, so any new G-T row automatically participates without per-test boilerplate. Rationale: D5 forbids stderr writes in JSON mode, D6 routes table-mode errors to stdout — jointly, the action handler must never write to stderr. An implementer who forgets the try/catch on one branch (or rethrows to bin's catch by accident) leaks there; suite-wide enforcement catches the regression. |
| **G-T11** | `signal` threads into `client.getIndex`: with the fake client in `hangUntilAbort` mode, aborting the controller causes `parseAsync` to resolve cleanly. Asserts (per D13): `render` is not invoked, `renderError` is not invoked, the in-memory `stdout` writer captured zero bytes, the in-memory `stderr` writer captured zero bytes, and `process.exitCode === 130`. Run the test under both `output:'table'` and `output:'json'` — silence is mode-independent. |
| **G-T12** | Invalid `--output='yaml'`, `isTTY=false`: action handler builds a fallback **JSON** renderer per D14. Asserts: envelope `{ok:false, error:{code:'USAGE', message:/invalid --output/i}, exitCode:2}` on stdout, stderr empty, `process.exitCode === 2`, and the injected fake `IndexClient` was **not** invoked (`getIndex` call count === 0). |
| **G-T13** | Invalid `--output='yaml'`, `isTTY=true`: action handler builds a fallback **table** renderer per D14. Asserts: `error [USAGE]: invalid --output: yaml\n` on stdout (no envelope, no ANSI escapes if `color:false`), stderr empty, `process.exitCode === 2`, `getIndex` call count === 0. |

### Test infrastructure conventions

- **In-memory writers**: small helper that wraps a `Writable` and exposes `.toString()`. Lives in `src/__tests__/fixtures/` if reused, otherwise inline. Each test constructs its own pair (stdout + stderr) — tests do not share writers across cases.
- **No spying on `process.stdout` directly**: the whole point of the DI is that the renderer/subcommand take writers as arguments. Tests must not patch globals. The one carve-out is `vi.stubEnv` for the env-independence runtime check in T12 — that is `vi`'s sanctioned API, not a manual global patch, and it is paired with `vi.unstubAllEnvs` in `afterEach`.
- **Suite-wide stderr-empty hook** (subcommand test file only): per G-T10, an `afterEach` hook reads the test's in-memory stderr writer and asserts `stderr.toString() === ''`. Construction pattern:
  ```ts
  let stderr: InMemoryWriter;
  beforeEach(() => { stderr = createInMemoryWriter(); });
  afterEach(() => { expect(stderr.toString()).toBe(''); });
  ```
  The `stderr` instance is the same one passed into `createGetCommand({ stderr, ... })`. Renderer tests do not need this hook — D12 already forbids stderr writes from the renderer, and T11 asserts it for completeness.
- **Deterministic JSON assertions**: prefer parsing the output and asserting against the parsed object, not string-matching the JSON form (except for the compact-format and trailing-newline assertions in T1/T2).
- **Color assertions**: assert presence/absence of `\x1b[`. Don't pin specific ANSI codes — chalk's exact escape sequences can vary across versions.

## Out of Scope

Explicit deferments. Each item has a one-line reason so a future reader knows whether it's "never" or "not yet."

- **YAML output** (`--output yaml`). Not yet. The format-resolution pipeline is extensible; adding YAML is a `renderer.ts` patch and a new branch in the subcommand's action handler. Deferred until a consumer needs it.
- **List/pagination rendering**. `TableFormat<T>` already accepts a `row` mapper that could be invoked per-item, but the demo subcommand is single-item only. The contract scales without breaking.
- **Structured `ABORTED` envelope on cancellation.** v1 intercepts `AbortError` in the action handler and exits 130 silently — see D13/G4/G-T11. A future iteration may surface an `ABORTED` envelope on stdout in JSON mode for consumers that read stdout-only and cannot observe the process exit code. The change is localized: remove the action-handler intercept, add an `err.name === 'AbortError'` branch in `renderer.renderError` producing `{code:'ABORTED', exitCode:130}`, and add a corresponding test. The renderer staying ignorant of cancellation in v1 is deliberate, not accidental.
- **Stderr separation in table mode**. Per D6, table-mode errors go to stdout for single-stream consistency. A future iteration may route `renderError`-in-`table`-mode to an injected `stderr` writer. The renderer's signature would gain one option; the action handler would change one line.
- **Coloring the bracketed code in table-mode errors.** Per R5, table-mode errors render as `error [CODE]: msg` with no color in v1. A future iteration may color the bracketed code via chalk (red for `INTERNAL`, yellow for `USAGE`, etc.) when `color:true`. One-line change in `renderer.renderError`'s table branch.
- **Tests for `bin/pcsk.ts`**. The scaffold's `CliError → exit code` mapping is exercised indirectly through the subcommand tests. We do not assert against the real `process.exit` or shell out to spawn the binary.
- **Real network clients**. The fake `IndexClient` is the seam. A real client implementing the same interface is a separate concern.
- **Internationalization** of error messages and table headers. English-only.
- **`--quiet` / `--verbose` / log levels**. The renderer produces one logical artifact per invocation; verbosity is not a knob.
- **Non-`Error` thrown values**. If a client `throw 'string'`s, behavior is undefined. The action handler is not required to normalize. (Real clients shouldn't do this.)
- **Pretty-printed JSON**. Compact only. `| jq .` is the answer.
- **Streaming output**. The renderer writes one logical chunk per `render` / `renderError` call. No streaming JSON, no progressive table rows.
- **Tests of `cli-table3` or `chalk` themselves**. We test our usage, not the libraries.

