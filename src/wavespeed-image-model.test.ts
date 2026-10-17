import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createWaveSpeed } from './wavespeed-provider';
import { WaveSpeedImageModel } from './wavespeed-image-model';
import {
  binaryResponse,
  createMockFetch,
  jsonResponse,
} from './test-utils';

const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function submitted(id = 'pred-123') {
  return jsonResponse({ code: 200, message: 'success', data: { id } });
}

function result(status: string, extra: Record<string, unknown> = {}) {
  return jsonResponse({
    code: 200,
    message: 'success',
    data: { id: 'pred-123', status, ...extra },
  });
}

function createModel(responses: Array<() => Response>) {
  const { fetch, requests } = createMockFetch(responses);
  const provider = createWaveSpeed({
    apiKey: 'test-key',
    fetch,
    pollIntervalMillis: 0,
  });
  return { model: provider.image('bytedance/seedream-v5.0-pro'), requests };
}

const baseOptions = {
  prompt: 'A sunrise over mountains',
  n: 1,
  size: undefined,
  aspectRatio: undefined,
  seed: undefined,
  files: undefined,
  mask: undefined,
  providerOptions: {},
} as const;

function createFastBackoffModel(responses: Array<() => Response>) {
  const { fetch, requests } = createMockFetch(responses);
  const model = new WaveSpeedImageModel('bytedance/seedream-v5.0-pro', {
    provider: 'wavespeed.image',
    baseURL: 'https://api.wavespeed.ai',
    headers: { Authorization: 'Bearer test-key' },
    fetch,
    pollIntervalMillis: 0,
    _internal: { pollErrorBackoffMillis: 0 },
  });
  return { model, requests };
}

const errorResponse = (status: number) => () =>
  jsonResponse({ code: status, message: `upstream ${status}`, data: null }, status);

describe('WaveSpeedImageModel', () => {
  describe('argument mapping', () => {
    it('maps prompt, size, seed and merges providerOptions passthrough', async () => {
      const { model, requests } = createModel([
        () => submitted(),
        () =>
          result('completed', {
            outputs: ['https://cdn.wavespeed.ai/out/1.png'],
          }),
        () => binaryResponse(IMAGE_BYTES),
      ]);

      await model.doGenerate({
        ...baseOptions,
        size: '2048x2048',
        seed: 42,
        providerOptions: {
          wavespeed: { enable_sync_mode: false, seed: 7 },
        },
      });

      expect(requests[0]!.url).toBe(
        'https://api.wavespeed.ai/api/v3/bytedance/seedream-v5.0-pro',
      );
      expect(requests[0]!.method).toBe('POST');
      expect(requests[0]!.body).toStrictEqual({
        prompt: 'A sunrise over mountains',
        size: '2048*2048',
        // passthrough wins over the mapped seed
        seed: 7,
        enable_sync_mode: false,
      });
      expect(requests[0]!.headers.authorization).toBe('Bearer test-key');
    });

    it('maps aspectRatio to aspect_ratio and omits undefined fields', async () => {
      const { model, requests } = createModel([
        () => submitted(),
        () => result('completed', { outputs: ['https://cdn.example/x.png'] }),
        () => binaryResponse(IMAGE_BYTES),
      ]);

      await model.doGenerate({ ...baseOptions, aspectRatio: '16:9' });

      expect(requests[0]!.body).toStrictEqual({
        prompt: 'A sunrise over mountains',
        aspect_ratio: '16:9',
      });
    });

    it('warns when n > 1 instead of sending an unsupported field', async () => {
      const { model } = createModel([
        () => submitted(),
        () => result('completed', { outputs: ['https://cdn.example/x.png'] }),
        () => binaryResponse(IMAGE_BYTES),
      ]);

      const generation = await model.doGenerate({ ...baseOptions, n: 4 });

      expect(generation.warnings).toStrictEqual([
        expect.objectContaining({ type: 'unsupported', feature: 'n' }),
      ]);
    });
  });

  describe('happy path', () => {
    it('submits, polls until completed, and downloads image bytes', async () => {
      const { model, requests } = createModel([
        () => submitted(),
        () => result('created'),
        () => result('processing'),
        () =>
          result('completed', {
            outputs: ['https://cdn.wavespeed.ai/out/1.png'],
          }),
        () => binaryResponse(IMAGE_BYTES),
      ]);

      const generation = await model.doGenerate({ ...baseOptions });

      expect(generation.images).toStrictEqual([IMAGE_BYTES]);
      expect(requests.map(r => r.url)).toStrictEqual([
        'https://api.wavespeed.ai/api/v3/bytedance/seedream-v5.0-pro',
        'https://api.wavespeed.ai/api/v3/predictions/pred-123/result',
        'https://api.wavespeed.ai/api/v3/predictions/pred-123/result',
        'https://api.wavespeed.ai/api/v3/predictions/pred-123/result',
        'https://cdn.wavespeed.ai/out/1.png',
      ]);
      expect(generation.providerMetadata?.wavespeed).toMatchObject({
        images: [{ url: 'https://cdn.wavespeed.ai/out/1.png' }],
        status: 'completed',
      });
      expect(generation.response.modelId).toBe('bytedance/seedream-v5.0-pro');
    });
  });

  describe('failure paths', () => {
    it.each(['failed', 'cancelled', 'timeout', 'deleted'])(
      'throws an APICallError when the prediction is %s',
      async status => {
        const { model } = createModel([
          () => submitted(),
          () => result(status, { error: 'Prediction did not complete' }),
        ]);

        await expect(model.doGenerate({ ...baseOptions })).rejects.toThrowError(
          new RegExp(`${status}.*Prediction did not complete`),
        );
      },
    );

    it('surfaces the WaveSpeed error envelope on submit errors', async () => {
      const { model } = createModel([
        () =>
          jsonResponse(
            { code: 401, message: 'Invalid API key', data: null },
            401,
          ),
      ]);

      await expect(
        model.doGenerate({ ...baseOptions }),
      ).rejects.toSatisfy(
        error =>
          APICallError.isInstance(error) &&
          error.message.includes('Invalid API key'),
      );
    });

    it('times out when the prediction never completes', async () => {
      const stuck = () => result('processing');
      const { fetch } = createMockFetch([
        () => submitted(),
        stuck,
        stuck,
        stuck,
      ]);
      const provider = createWaveSpeed({
        apiKey: 'test-key',
        fetch,
        pollIntervalMillis: 0,
        pollTimeoutMillis: 0,
      });
      const model = provider.image('bytedance/seedream-v5.0-pro');

      await expect(model.doGenerate({ ...baseOptions })).rejects.toThrowError(
        /still 'processing'/,
      );
    });
  });

  describe('retry safety (no duplicate paid tasks)', () => {
    it('tolerates a poll 502 without re-submitting', async () => {
      const { model, requests } = createFastBackoffModel([
        () => submitted(),
        errorResponse(502),
        () =>
          result('completed', {
            outputs: ['https://cdn.wavespeed.ai/out/1.png'],
          }),
        () => binaryResponse(IMAGE_BYTES),
      ]);

      const res = await model.doGenerate({ ...baseOptions });

      expect(res.images).toHaveLength(1);
      expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
    });

    it('throws a non-retryable error naming the task id when polling keeps failing', async () => {
      const { model, requests } = createFastBackoffModel([
        () => submitted('pred-xyz'),
        ...Array.from({ length: 6 }, () => errorResponse(503)),
      ]);

      const error = await model.doGenerate({ ...baseOptions }).catch(e => e);

      expect(APICallError.isInstance(error)).toBe(true);
      expect(error.isRetryable).toBe(false);
      expect(error.message).toContain('pred-xyz');
      // 1 submit + initial poll + 5 retries
      expect(requests).toHaveLength(7);
    });

    it('does not retry a non-transient poll error (401)', async () => {
      const { model, requests } = createFastBackoffModel([
        () => submitted('pred-401'),
        errorResponse(401),
      ]);

      const error = await model.doGenerate({ ...baseOptions }).catch(e => e);

      expect(error.isRetryable).toBe(false);
      expect(error.message).toContain('pred-401');
      expect(requests).toHaveLength(2);
    });

    it.each([504, 500, 429, 408])(
      'submit %s is non-retryable and not retried internally',
      async status => {
        const { model, requests } = createFastBackoffModel([
          errorResponse(status),
        ]);

        const error = await model.doGenerate({ ...baseOptions }).catch(e => e);

        expect(APICallError.isInstance(error)).toBe(true);
        expect(error.statusCode).toBe(status);
        expect(error.isRetryable).toBe(false);
        expect(requests).toHaveLength(1);
      },
    );

    it('submit network error is non-retryable', async () => {
      const fetch = async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error('ECONNRESET'),
        });
      };
      const model = new WaveSpeedImageModel('m', {
        provider: 'wavespeed.image',
        baseURL: 'https://api.wavespeed.ai',
        fetch,
      });

      const error = await model.doGenerate({ ...baseOptions }).catch(e => e);

      expect(APICallError.isInstance(error)).toBe(true);
      expect(error.isRetryable).toBe(false);
    });

    it.each([500, 502, 503])(
      'output download %s is non-retryable so the AI SDK cannot re-submit',
      async status => {
        const { model, requests } = createFastBackoffModel([
          submitted,
          () => result('completed', { outputs: ['https://static.wavespeed.ai/o.png'] }),
          errorResponse(status),
        ]);

        const error = await model.doGenerate({ ...baseOptions }).catch(e => e);

        expect(APICallError.isInstance(error)).toBe(true);
        expect(error.isRetryable).toBe(false);
        expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
      },
    );
  });
});
