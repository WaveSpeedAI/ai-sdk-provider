import type { FetchFunction } from '@ai-sdk/provider-utils';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Creates a mock fetch that replays a scripted list of responses in order
 * and records every request it receives.
 */
export function createMockFetch(
  responses: Array<() => Response>,
): { fetch: FetchFunction; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetch: FetchFunction = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    let body: unknown = undefined;
    if (init?.body != null && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        new Headers(init?.headers as HeadersInit | undefined).entries(),
      ),
      body,
    });

    const next = responses[index];
    if (next == null) {
      throw new Error(`Unexpected request #${index + 1} to ${url}`);
    }
    index++;
    return next();
  };

  return { fetch, requests };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function binaryResponse(bytes: Uint8Array): Response {
  return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}
