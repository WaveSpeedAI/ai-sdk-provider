import { NoSuchModelError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createWaveSpeed } from './wavespeed-provider';
import {
  createMockFetch,
  binaryResponse,
  jsonResponse,
} from './test-utils';

describe('createWaveSpeed', () => {
  const provider = createWaveSpeed({ apiKey: 'test-key' });

  it('creates image models with the wavespeed.image provider name', () => {
    const model = provider.image('bytedance/seedream-v5.0-pro');
    expect(model.provider).toBe('wavespeed.image');
    expect(model.modelId).toBe('bytedance/seedream-v5.0-pro');
    expect(model.specificationVersion).toBe('v4');
  });

  it('creates video models with the wavespeed.video provider name', () => {
    const model = provider.video('bytedance/seedance-2.5/text-to-video');
    expect(model.provider).toBe('wavespeed.video');
    expect(model.specificationVersion).toBe('v4');
  });

  it('imageModel and videoModel are aliases of image and video', () => {
    expect(provider.imageModel('m').provider).toBe('wavespeed.image');
    expect(provider.videoModel('m').provider).toBe('wavespeed.video');
  });

  it('throws NoSuchModelError for unsupported model types', () => {
    expect(() => provider.languageModel('m')).toThrowError(NoSuchModelError);
    expect(() => provider.embeddingModel('m')).toThrowError(NoSuchModelError);
  });

  it('throws when no API key is available', async () => {
    const original = process.env.WAVESPEED_API_KEY;
    delete process.env.WAVESPEED_API_KEY;
    try {
      const p = createWaveSpeed();
      const model = p.image('m');
      await expect(
        model.doGenerate({
          prompt: 'x',
          n: 1,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          files: undefined,
          mask: undefined,
          providerOptions: {},
        }),
      ).rejects.toThrowError(/WAVESPEED_API_KEY/);
    } finally {
      if (original != null) process.env.WAVESPEED_API_KEY = original;
    }
  });

  describe('channel-attribution headers', () => {
    const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

    const baseOptions = {
      prompt: 'x',
      n: 1,
      size: undefined,
      aspectRatio: undefined,
      seed: undefined,
      files: undefined,
      mask: undefined,
      providerOptions: {},
    } as const;

    function successResponses() {
      return [
        () => jsonResponse({ code: 200, message: 'success', data: { id: 'p-1' } }),
        () =>
          jsonResponse({
            code: 200,
            message: 'success',
            data: {
              id: 'p-1',
              status: 'completed',
              outputs: ['https://cdn.example/x.png'],
            },
          }),
        () => binaryResponse(IMAGE_BYTES),
      ];
    }

    it('sends X-Client-Name, X-Client-Version, and X-Client-OS by default', async () => {
      const { fetch, requests } = createMockFetch(successResponses());
      const p = createWaveSpeed({ apiKey: 'test-key', fetch, pollIntervalMillis: 0 });

      await p.image('m').doGenerate({ ...baseOptions });

      const headers = requests[0]!.headers;
      expect(headers['x-client-name']).toBe('wavespeed-ai-sdk-provider');
      expect(headers['x-client-version']).toMatch(/^\d+\.\d+\.\d+/);
      expect(['darwin', 'linux', 'windows']).toContain(headers['x-client-os']);
    });

    it('user-supplied headers override the attribution defaults', async () => {
      const { fetch, requests } = createMockFetch(successResponses());
      const p = createWaveSpeed({
        apiKey: 'test-key',
        fetch,
        pollIntervalMillis: 0,
        headers: { 'X-Client-Name': 'my-app' },
      });

      await p.image('m').doGenerate({ ...baseOptions });

      expect(requests[0]!.headers['x-client-name']).toBe('my-app');
    });

    it('WAVESPEED_CLIENT_NAME env var overrides the default name', async () => {
      const original = process.env.WAVESPEED_CLIENT_NAME;
      process.env.WAVESPEED_CLIENT_NAME = 'gemini-extension';
      try {
        const { fetch, requests } = createMockFetch(successResponses());
        const p = createWaveSpeed({ apiKey: 'test-key', fetch, pollIntervalMillis: 0 });

        await p.image('m').doGenerate({ ...baseOptions });

        expect(requests[0]!.headers['x-client-name']).toBe('gemini-extension');
      } finally {
        if (original === undefined) {
          delete process.env.WAVESPEED_CLIENT_NAME;
        } else {
          process.env.WAVESPEED_CLIENT_NAME = original;
        }
      }
    });
  });
});
