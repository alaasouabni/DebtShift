import { describe, expect, it, vi } from 'vitest';

import { ApiError, DebtShiftApi, normalizeErrorBody } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetcher: typeof fetch) {
  return new DebtShiftApi({ baseUrl: 'http://localhost:3001/v1', fetcher });
}

/**
 * A spy with fetch's real parameter list, so `mock.calls[n]` is a two-element
 * tuple and the assertions below can read the URL and the init object.
 */
function mockFetch(respond: () => Response) {
  return vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(respond()));
}

describe('normalizeErrorBody', () => {
  it('reads a single string message', () => {
    expect(normalizeErrorBody({ message: 'No approved executable route.' })).toEqual([
      'No approved executable route.',
    ]);
  });

  it('reads an array of messages, as class-validator sends them', () => {
    expect(
      normalizeErrorBody({
        message: ['borrower must be an address', 'wallet should not be empty'],
        statusCode: 400,
      }),
    ).toEqual(['borrower must be an address', 'wallet should not be empty']);
  });

  it('drops empty entries from an array', () => {
    expect(normalizeErrorBody({ message: ['kept', '', '   '] })).toEqual(['kept']);
  });

  it('falls back to the error field', () => {
    expect(normalizeErrorBody({ error: 'Not Found', statusCode: 404 })).toEqual(['Not Found']);
  });

  it('returns nothing for a shape it does not recognise', () => {
    expect(normalizeErrorBody({ unexpected: true })).toEqual([]);
    expect(normalizeErrorBody(null)).toEqual([]);
    expect(normalizeErrorBody(42)).toEqual([]);
  });

  it('reads a bare string body', () => {
    expect(normalizeErrorBody('Internal Server Error')).toEqual(['Internal Server Error']);
  });
});

describe('DebtShiftApi error handling', () => {
  it('preserves the status and joins array messages', async () => {
    const api = client(async () =>
      jsonResponse({ message: ['first problem', 'second problem'], statusCode: 400 }, 400),
    );

    const error = await api.prepare('0xabc').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('VALIDATION');
    expect(apiError.messages).toEqual(['first problem', 'second problem']);
    expect(apiError.message).toBe('first problem second problem');
  });

  it('surfaces a fail-closed preparation error verbatim rather than a generic failure', async () => {
    // The real message the backend returns when no route satisfies the policy.
    const backend = 'No approved executable route satisfies the deterministic policy.';
    const api = client(async () => jsonResponse({ message: backend, statusCode: 400 }, 400));

    const error = (await api.prepare('0xabc').catch((caught: unknown) => caught)) as ApiError;
    expect(error.message).toBe(backend);
  });

  it('maps a 404 to NOT_FOUND', async () => {
    const api = client(async () => jsonResponse({ message: 'Migration not found.' }, 404));
    const error = (await api.migration('0xdead').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
  });

  it('maps a 500 to SERVER', async () => {
    const api = client(async () => jsonResponse({ message: 'boom' }, 500));
    const error = (await api.markets().catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('SERVER');
  });

  it('never treats an unparseable 200 as success', async () => {
    const api = client(async () => new Response('<html>gateway</html>', { status: 200 }));
    const error = (await api.markets().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('MALFORMED');
  });

  it('never treats an empty 200 body as success', async () => {
    const api = client(async () => new Response('', { status: 200 }));
    const error = (await api.markets().catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('MALFORMED');
  });

  it('reports an unreachable API as NETWORK', async () => {
    const api = client(async () => {
      throw new TypeError('fetch failed');
    });
    const error = (await api.health().catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
  });

  it('gives a message even when the backend body carries none', async () => {
    const api = client(async () => jsonResponse({ unexpected: true }, 400));
    const error = (await api.markets().catch((caught: unknown) => caught)) as ApiError;
    expect(error.messages).toEqual([]);
    expect(error.message).toContain('/markets');
  });
});

describe('DebtShiftApi requests', () => {
  it('unwraps the single-element array the position endpoint returns', async () => {
    const snapshot = { snapshotId: '0x01', collateralUnits: '10000000000000000000' };
    const fetcher = mockFetch(() => jsonResponse([snapshot]));
    const api = client(fetcher as unknown as typeof fetch);

    await expect(api.position('0x7099')).resolves.toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:3001/v1/positions/0x7099',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns undefined when the wallet has no supported position', async () => {
    const api = client(async () => jsonResponse([]));
    await expect(api.position('0x7099')).resolves.toBeUndefined();
  });

  it('rejects when the position endpoint stops returning a list', async () => {
    const api = client(async () => jsonResponse({ snapshotId: '0x01' }));
    const error = (await api.position('0x7099').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('MALFORMED');
  });

  it('omits explanation entirely when none is chosen', async () => {
    const fetcher = mockFetch(() => jsonResponse({ analysis: {}, explanations: [] }));
    const api = client(fetcher as unknown as typeof fetch);

    await api.analyzeRoutes('0x7099');
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string) as unknown;
    expect(body).toEqual({ wallet: '0x7099' });
  });

  it('sends the chosen explanation configuration', async () => {
    const fetcher = mockFetch(() => jsonResponse({ analysis: {}, explanations: [] }));
    const api = client(fetcher as unknown as typeof fetch);

    await api.analyzeRoutes('0x7099', {
      mode: 'LOCAL_AI',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
    });
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string) as {
      explanation: { mode: string };
    };
    expect(body.explanation.mode).toBe('LOCAL_AI');
  });

  it('sets the JSON content type on writes and nothing on reads', async () => {
    const fetcher = mockFetch(() => jsonResponse({ migrationId: '0x01' }));
    const api = client(fetcher as unknown as typeof fetch);

    await api.prepare('0x7099');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
    });

    fetcher.mockClear();
    fetcher.mockImplementation(() => Promise.resolve(jsonResponse([])));
    await api.markets();
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it('never puts a user API key in the URL', async () => {
    const fetcher = mockFetch(() => jsonResponse({ analysis: {}, explanations: [] }));
    const api = client(fetcher as unknown as typeof fetch);

    await api.analyzeRoutes('0x7099', {
      mode: 'USER_API',
      provider: 'OPENAI',
      model: 'gpt-4o',
      apiKey: 'sk-secret-value',
    });

    const url = String(fetcher.mock.calls[0]?.[0]);
    expect(url).not.toContain('sk-secret-value');
    expect(url).toBe('http://localhost:3001/v1/analysis/routes');
  });

  it('keeps a user API key out of the error surface when the request fails', async () => {
    const api = client(async () => jsonResponse({ message: 'upstream refused' }, 400));

    const error = (await api
      .analyzeRoutes('0x7099', {
        mode: 'USER_API',
        provider: 'OPENAI',
        model: 'gpt-4o',
        apiKey: 'sk-secret-value',
      })
      .catch((caught: unknown) => caught)) as ApiError;

    const serialized = `${error.message} ${error.path} ${error.messages.join(' ')}`;
    expect(serialized).not.toContain('sk-secret-value');
  });

  it('strips a trailing slash from the configured base URL', () => {
    const api = new DebtShiftApi({ baseUrl: 'http://localhost:3001/v1/' });
    expect(api.baseUrl).toBe('http://localhost:3001/v1');
  });

  it('percent-encodes a path parameter', async () => {
    const fetcher = mockFetch(() => jsonResponse({ migration: {} }));
    const api = client(fetcher as unknown as typeof fetch);
    await api.migration('0x7f/../admin');
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/v1/migrations/0x7f%2F..%2Fadmin',
    );
  });
});
