import { NoSuchModelError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createWaveSpeed } from './wavespeed-provider';

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
});
