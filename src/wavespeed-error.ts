import { createJsonErrorResponseHandler } from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

/**
 * WaveSpeed error envelope. Non-2xx responses carry
 * `{ code, message }` (and sometimes an `error_code`).
 */
export const waveSpeedErrorDataSchema = z.looseObject({
  code: z.number().nullish(),
  message: z.string().nullish(),
  error_code: z.string().nullish(),
});

export type WaveSpeedErrorData = z.infer<typeof waveSpeedErrorDataSchema>;

export const waveSpeedFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: waveSpeedErrorDataSchema,
  errorToMessage: error =>
    error.message
      ? error.error_code
        ? `${error.message} [${error.error_code}]`
        : error.message
      : 'Unknown WaveSpeed error',
});
