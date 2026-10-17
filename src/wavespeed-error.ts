import { APICallError } from '@ai-sdk/provider';
import { createJsonErrorResponseHandler, delay } from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import { DEFAULT_REQUEST_TIMEOUT_MILLIS } from './wavespeed-config';

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

/**
 * The AI SDK (`generateImage` / `generateVideo`) re-invokes `doGenerate` /
 * `doStart` when they throw an `APICallError` with `isRetryable === true`
 * (default for 408/409/429/5xx and network errors). A re-invoke would POST a
 * second, separately billed task, so errors from submit and polling are
 * re-thrown as non-retryable. Transient poll failures are retried inside the
 * model instead (see `getWithPollRetry`).
 */
export function asNonRetryable(error: unknown, suffix = ''): unknown {
  if (!APICallError.isInstance(error)) return error;
  if (error.isRetryable === false && suffix === '') return error;
  return new APICallError({
    message: error.message + suffix,
    url: error.url,
    requestBodyValues: error.requestBodyValues,
    statusCode: error.statusCode,
    responseHeaders: error.responseHeaders,
    responseBody: error.responseBody,
    cause: error.cause,
    data: error.data,
    isRetryable: false,
  });
}

/**
 * Runs one HTTP request with a bounded per-request timeout combined with the
 * caller's abortSignal. A caller abort is re-thrown untouched; a timeout
 * becomes a retryable APICallError (no status code), which polling treats as
 * transient and submit converts to a non-retryable (ambiguous) error.
 */
export async function withRequestTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  {
    abortSignal,
    timeoutMillis = DEFAULT_REQUEST_TIMEOUT_MILLIS,
    url,
  }: { abortSignal?: AbortSignal; timeoutMillis?: number; url: string },
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMillis);
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fn(signal);
  } catch (error) {
    if (timeoutSignal.aborted && !abortSignal?.aborted) {
      throw new APICallError({
        message: `WaveSpeed request timed out after ${timeoutMillis}ms`,
        url,
        requestBodyValues: {},
        cause: error,
        isRetryable: true,
      });
    }
    throw error;
  }
}

const POLL_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
export const POLL_MAX_RETRIES = 5;
export const DEFAULT_POLL_ERROR_BACKOFF_MILLIS = 1000;

/** 429/500/502/503/504 and network errors (no status code) are transient. */
export function isTransientPollError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode == null) return error.isRetryable === true;
  return POLL_RETRYABLE_STATUS.has(error.statusCode);
}

/**
 * Runs a poll GET, retrying transient failures up to POLL_MAX_RETRIES times
 * with growing backoff (backoffMillis * (n + 1)), matching wavespeed-python.
 * The final error is non-retryable and names the prediction id.
 */
export async function getWithPollRetry<T>(
  fn: () => Promise<T>,
  {
    predictionId,
    backoffMillis = DEFAULT_POLL_ERROR_BACKOFF_MILLIS,
    abortSignal,
  }: {
    predictionId: string;
    backoffMillis?: number;
    abortSignal?: AbortSignal;
  },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isTransientPollError(error) && attempt < POLL_MAX_RETRIES) {
        await delay(backoffMillis * (attempt + 1), { abortSignal });
        continue;
      }
      throw asNonRetryable(
        error,
        ` (prediction id: ${predictionId}; the task keeps running server-side)`,
      );
    }
  }
}
