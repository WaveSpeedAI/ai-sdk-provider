import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createWaveSpeed } from './wavespeed-provider';
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
});
