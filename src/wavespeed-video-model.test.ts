import { describe, expect, it } from 'vitest';
import { createWaveSpeed } from './wavespeed-provider';
import { createMockFetch, jsonResponse } from './test-utils';

function submitted(id = 'vid-456') {
  return jsonResponse({ code: 200, message: 'success', data: { id } });
}

function result(status: string, extra: Record<string, unknown> = {}) {
  return jsonResponse({
    code: 200,
    message: 'success',
    data: { id: 'vid-456', status, ...extra },
  });
}

function createModel(responses: Array<() => Response>) {
  const { fetch, requests } = createMockFetch(responses);
  const provider = createWaveSpeed({ apiKey: 'test-key', fetch });
  return {
    model: provider.video('bytedance/seedance-2.5/text-to-video'),
    requests,
  };
}

const baseOptions = {
  prompt: 'A drone shot over a coastline',
  n: 1,
  aspectRatio: undefined,
  resolution: undefined,
  duration: undefined,
  fps: undefined,
  seed: undefined,
  image: undefined,
  frameImages: undefined,
  inputReferences: undefined,
  generateAudio: undefined,
  providerOptions: {},
} as const;

describe('WaveSpeedVideoModel', () => {
  describe('doStart', () => {
    it('maps args to the WaveSpeed request body and returns the operation', async () => {
      const { model, requests } = createModel([() => submitted()]);

      const started = await model.doStart!({
        ...baseOptions,
        aspectRatio: '16:9',
        duration: 5,
        seed: 3,
        providerOptions: { wavespeed: { resolution: '720p' } },
      });

      expect(requests[0]!.url).toBe(
        'https://api.wavespeed.ai/api/v3/bytedance/seedance-2.5/text-to-video',
      );
      expect(requests[0]!.body).toStrictEqual({
        prompt: 'A drone shot over a coastline',
        aspect_ratio: '16:9',
        duration: 5,
        seed: 3,
        resolution: '720p',
      });
      expect(requests[0]!.headers.authorization).toBe('Bearer test-key');
      expect(started.operation).toStrictEqual({ predictionId: 'vid-456' });
    });

    it('maps an image url input for image-to-video', async () => {
      const { model, requests } = createModel([() => submitted()]);

      await model.doStart!({
        ...baseOptions,
        image: { type: 'url', url: 'https://example.com/frame.png' },
      });

      expect(requests[0]!.body).toMatchObject({
        image: 'https://example.com/frame.png',
      });
    });
  });

  describe('doStatus', () => {
    it('returns pending while the prediction is processing', async () => {
      const { model } = createModel([() => result('processing')]);

      const status = await model.doStatus!({
        operation: { predictionId: 'vid-456' },
      });

      expect(status.status).toBe('pending');
    });

    it('returns completed videos as URLs', async () => {
      const { model, requests } = createModel([
        () =>
          result('completed', {
            outputs: ['https://cdn.wavespeed.ai/out/video.mp4'],
          }),
      ]);

      const status = await model.doStatus!({
        operation: { predictionId: 'vid-456' },
      });

      expect(requests[0]!.url).toBe(
        'https://api.wavespeed.ai/api/v3/predictions/vid-456/result',
      );
      expect(status).toMatchObject({
        status: 'completed',
        videos: [
          {
            type: 'url',
            url: 'https://cdn.wavespeed.ai/out/video.mp4',
            mediaType: 'video/mp4',
          },
        ],
      });
    });

    it('returns an error status when the prediction fails', async () => {
      const { model } = createModel([
        () => result('failed', { error: 'capacity exceeded' }),
      ]);

      const status = await model.doStatus!({
        operation: { predictionId: 'vid-456' },
      });

      expect(status.status).toBe('error');
      expect(status).toMatchObject({
        error: expect.stringContaining('capacity exceeded'),
      });
    });

    it('converts API errors into an error status', async () => {
      const { model } = createModel([
        () =>
          jsonResponse({ code: 500, message: 'internal error', data: null }, 500),
      ]);

      const status = await model.doStatus!({
        operation: { predictionId: 'vid-456' },
      });

      expect(status.status).toBe('error');
    });
  });
});
