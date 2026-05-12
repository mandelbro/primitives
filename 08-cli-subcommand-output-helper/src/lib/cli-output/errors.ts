export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class NotFoundError extends CliError {
  constructor(resource: string, name: string) {
    super(`${resource} not found: ${name}`, 3);
    this.name = 'NotFoundError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}
