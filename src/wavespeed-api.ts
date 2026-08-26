import { z } from 'zod/v4';

/**
 * Envelope returned when submitting a prediction:
 * POST https://api.wavespeed.ai/api/v3/{modelId}
 */
export const waveSpeedSubmitResponseSchema = z.object({
  code: z.number(),
  message: z.string().nullish(),
  data: z.looseObject({
    id: z.string(),
  }),
});

/**
 * Envelope returned when polling a prediction:
 * GET https://api.wavespeed.ai/api/v3/predictions/{id}/result
 */
export const waveSpeedResultResponseSchema = z.object({
  code: z.number(),
  message: z.string().nullish(),
  data: z.looseObject({
    id: z.string(),
    status: z.string(),
    outputs: z.array(z.string()).nullish(),
    error: z.string().nullish(),
    timings: z.record(z.string(), z.number()).nullish(),
    has_nsfw_contents: z.array(z.boolean()).nullish(),
  }),
});

export type WaveSpeedResultResponse = z.infer<
  typeof waveSpeedResultResponseSchema
>;

export function isTerminalFailure(status: string): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'timeout' || status === 'deleted';
}
