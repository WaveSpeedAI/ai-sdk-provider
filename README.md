# WaveSpeed provider for the Vercel AI SDK

The **[WaveSpeed](https://wavespeed.ai)** provider for the
[Vercel AI SDK](https://ai-sdk.dev) gives you access to WaveSpeed's image and
video generation models through the standard AI SDK interfaces
(`generateImage` / `generateVideo`).

## Installation

```bash
npm install @wavespeed/ai-sdk-provider
```

## Setup

Get an API key from the [WaveSpeed dashboard](https://wavespeed.ai) and expose
it as the `WAVESPEED_API_KEY` environment variable:

```bash
export WAVESPEED_API_KEY="your-api-key"
```

Alternatively, pass it explicitly:

```ts
import { createWaveSpeed } from '@wavespeed/ai-sdk-provider';

const wavespeed = createWaveSpeed({
  apiKey: 'your-api-key',
});
```

## Image generation

```ts
import { wavespeed } from '@wavespeed/ai-sdk-provider';
import { experimental_generateImage as generateImage } from 'ai';
import { writeFileSync } from 'node:fs';

const { image } = await generateImage({
  model: wavespeed.image('bytedance/seedream-v5.0-pro'),
  prompt: 'A serene mountain lake at sunrise, photorealistic',
  size: '2048x2048',
});

writeFileSync('output.png', image.uint8Array);
```

The provider submits the prediction, polls WaveSpeed until it completes
(1s interval, 10 minute timeout by default — configurable via
`pollIntervalMillis` / `pollTimeoutMillis` in `createWaveSpeed`), and returns
the downloaded image bytes.

## Video generation

```ts
import { wavespeed } from '@wavespeed/ai-sdk-provider';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: wavespeed.video('bytedance/seedance-2.5/text-to-video'),
  prompt: 'A drone shot flying over a rugged coastline at golden hour',
  aspectRatio: '16:9',
  duration: 5,
});

console.log(video.url);
```

Video models implement the AI SDK's asynchronous start/status flow, so the
AI SDK core orchestrates polling for you.

## Provider options

Model-specific inputs that are not part of the standard AI SDK call options
can be passed through `providerOptions.wavespeed`. They are merged into the
request body and take precedence over the mapped standard options:

```ts
const { image } = await generateImage({
  model: wavespeed.image('bytedance/seedream-v5.0-pro'),
  prompt: 'A cyberpunk city street at night',
  providerOptions: {
    wavespeed: {
      size: '3840*2160',
      enable_sync_mode: false,
    },
  },
});
```

Consult the model's page on [wavespeed.ai](https://wavespeed.ai) for the
exact input schema of each model. Fields that a model does not declare in its
schema are ignored by the API.

## Argument mapping

| AI SDK option | WaveSpeed request field |
| --- | --- |
| `prompt` | `prompt` |
| `size` (`{width}x{height}`) | `size` (`{width}*{height}`) |
| `aspectRatio` | `aspect_ratio` |
| `seed` | `seed` |
| `duration` (video) | `duration` |
| `resolution` (video) | `resolution` |
| `fps` (video) | `fps` |
| `generateAudio` (video) | `generate_audio` |
| image / file inputs | `image` / `images` |
| `providerOptions.wavespeed.*` | passed through as-is (wins on conflict) |

Only defined values are sent.

## License

MIT

---

**[WaveSpeed AI](https://wavespeed.ai/)** — hosted inference for image, video, audio and 3D models.
Try it in the browser: **[Image generator](https://wavespeed.ai/image-generator)** · **[Video generator](https://wavespeed.ai/video-generator)**
