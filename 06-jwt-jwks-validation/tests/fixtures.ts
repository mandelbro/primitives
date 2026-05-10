import {
  generateKeyPair as joseGenerateKeyPair,
  exportJWK,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import express, { type Express } from 'express';
import { jwtAuth } from '../src/jwt-auth.js';
import type { JwtAuthOptions } from '../src/types.js';

export interface KeyMaterial {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
}

export async function generateTestKeyPair(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await joseGenerateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kty = 'RSA';
  return { kid, privateKey, publicJwk };
}

export interface SignOptions {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  scope?: unknown;
  extra?: Record<string, unknown>;
  headerOverrides?: Record<string, unknown>;
}

export async function signWithKey(
  privateKey: KeyLike,
  kid: string,
  signOpts: SignOptions = {},
): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (signOpts.iss !== undefined) payload['iss'] = signOpts.iss;
  if (signOpts.aud !== undefined) payload['aud'] = signOpts.aud;
  if (signOpts.sub !== undefined) payload['sub'] = signOpts.sub;
  if (signOpts.exp !== undefined) payload['exp'] = signOpts.exp;
  if (signOpts.nbf !== undefined) payload['nbf'] = signOpts.nbf;
  if (signOpts.iat !== undefined) payload['iat'] = signOpts.iat;
  if (signOpts.scope !== undefined) payload['scope'] = signOpts.scope;
  if (signOpts.extra) Object.assign(payload, signOpts.extra);

  const header = { alg: 'RS256', kid, ...(signOpts.headerOverrides ?? {}) };
  return new SignJWT(payload).setProtectedHeader(header as never).sign(privateKey);
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString('base64url');
}

export function craftRawJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature: string = '',
): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.${signature}`;
}

export function craftTwoSegmentJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
}

export function jwks(keys: JWK[]): { keys: JWK[] } {
  return { keys };
}

export interface FakeNow {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
}

export function fakeNow(initial: number = 1_700_000_000_000): FakeNow {
  let current = initial;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

export interface QueuedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface FakeFetcher {
  fetcher: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
  callCountFor: (url: string) => number;
  enqueue: (url: string, response: QueuedResponse) => void;
  enqueueRaw: (url: string, body: string, status?: number) => void;
  enqueueError: (url: string, err: Error) => void;
}

type Producer = () => Promise<Response>;

export function fakeFetcher(): FakeFetcher {
  const queues = new Map<string, Producer[]>();
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const queue = queues.get(url);
    if (!queue || queue.length === 0) {
      throw new Error(`fakeFetcher: no response queued for ${url}`);
    }
    const next = queue.shift();
    return next!();
  };

  const push = (url: string, producer: Producer): void => {
    const existing = queues.get(url);
    if (existing) {
      existing.push(producer);
    } else {
      queues.set(url, [producer]);
    }
  };

  return {
    fetcher,
    calls,
    callCountFor: (url) => calls.filter((c) => c.url === url).length,
    enqueue: (url, response) =>
      push(url, async () => {
        if (response.delayMs) {
          await new Promise<void>((resolve) => setTimeout(resolve, response.delayMs));
        }
        return new Response(JSON.stringify(response.body ?? {}), {
          status: response.status ?? 200,
          headers: { 'content-type': 'application/json', ...response.headers },
        });
      }),
    enqueueRaw: (url, body, status = 200) =>
      push(url, async () =>
        new Response(body, {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    enqueueError: (url, err) =>
      push(url, async () => {
        throw err;
      }),
  };
}

export const TEST_JWKS_URI = 'https://idp.test.invalid/.well-known/jwks.json';
export const TEST_ISSUER = 'https://idp.test.invalid/';
export const TEST_AUDIENCE = 'urn:test:api';

export interface MountAppOpts extends Partial<JwtAuthOptions> {
  routes?: (app: Express) => void;
}

export function defaultOpts(overrides: Partial<JwtAuthOptions> = {}): JwtAuthOptions {
  return {
    jwksUri: TEST_JWKS_URI,
    audience: TEST_AUDIENCE,
    issuer: TEST_ISSUER,
    ...overrides,
  };
}

export function mountApp(opts: JwtAuthOptions, configure?: (app: Express) => void): Express {
  const app = express();
  if (configure) {
    configure(app);
  } else {
    app.get('/protected', jwtAuth(opts), (req, res) => {
      res.json({ auth: req.auth });
    });
  }
  // Default error handler so thrown errors surface as 500 (G1, G2 rely on this).
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

export function nowSec(ms: number): number {
  return Math.floor(ms / 1000);
}
