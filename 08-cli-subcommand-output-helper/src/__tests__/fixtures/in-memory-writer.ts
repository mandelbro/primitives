import { Writable } from 'node:stream';

export interface InMemoryWriter {
  readonly writer: NodeJS.WritableStream;
  toString(): string;
}

export function createInMemoryWriter(): InMemoryWriter {
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
