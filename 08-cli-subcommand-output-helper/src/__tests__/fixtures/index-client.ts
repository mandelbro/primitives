import { NotFoundError } from '../../lib/cli-output/errors.js';

export interface Index {
  name: string;
  status: string;
  dimension: number;
  metric: string;
  replicas: number;
  createdAt: string;
}

export interface IndexClient {
  getIndex(name: string, signal?: AbortSignal): Promise<Index>;
}

export interface FakeClientOptions {
  /** Resolve `getIndex` with this index. Mutually exclusive with the other modes. */
  index?: Index;
  /** Reject `getIndex` with `NotFoundError('index', name)`. */
  notFound?: boolean;
  /** Reject `getIndex` with this error verbatim. Overrides other modes. */
  error?: Error;
  /**
   * Hang until the caller's `AbortSignal` fires, then reject with an
   * `AbortError`. Used to exercise cancellation paths.
   */
  hangUntilAbort?: boolean;
}

export const DEFAULT_INDEX: Index = {
  name: 'demo-index',
  status: 'Ready',
  dimension: 1536,
  metric: 'cosine',
  replicas: 1,
  createdAt: '2025-01-15T10:00:00.000Z',
};

export function createFakeIndexClient(opts: FakeClientOptions = {}): IndexClient {
  return {
    async getIndex(name: string, signal?: AbortSignal): Promise<Index> {
      if (opts.error) {
        throw opts.error;
      }
      if (opts.notFound) {
        throw new NotFoundError('index', name);
      }
      if (opts.hangUntilAbort) {
        return new Promise<Index>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return opts.index ?? DEFAULT_INDEX;
    },
  };
}
