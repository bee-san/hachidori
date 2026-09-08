// SPDX-License-Identifier: GPL-3.0-or-later
//
// Small C ABI around libavif's sequence encoder. The caller supplies one RGBA
// frame at a time, so decoded frame memory never accumulates in WebAssembly.

#include <emscripten/emscripten.h>
#include <avif/avif.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  HDA_MAX_WIDTH = 640,
  HDA_MAX_HEIGHT = 360,
  HDA_MAX_FRAMES = 120,
  HDA_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
};

typedef struct {
  avifEncoder *encoder;
  avifRWData output;
  uint32_t width;
  uint32_t height;
  uint32_t frame_count;
  int finished;
  char error[256];
} HdaEncoder;

static char global_error[256];

static int fail(HdaEncoder *encoder, const char *message) {
  char *target = encoder ? encoder->error : global_error;
  snprintf(target, 256, "%s", message ? message : "unknown AVIF encoder failure");
  return 0;
}

static int avif_fail(HdaEncoder *encoder, const char *operation, avifResult result) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s", operation, avifResultToString(result));
  return fail(encoder, message);
}

EMSCRIPTEN_KEEPALIVE
HdaEncoder *hda_create(uint32_t width, uint32_t height, uint32_t timescale, int quality, int speed) {
  global_error[0] = '\0';
  if (width == 0 || height == 0 || width > HDA_MAX_WIDTH || height > HDA_MAX_HEIGHT
      || (width & 1U) != 0 || (height & 1U) != 0) {
    fail(NULL, "AVIF dimensions must be even and no larger than 640 by 360");
    return NULL;
  }
  if (timescale == 0 || quality < AVIF_QUALITY_WORST || quality > AVIF_QUALITY_BEST
      || speed < AVIF_SPEED_SLOWEST || speed > AVIF_SPEED_FASTEST) {
    fail(NULL, "AVIF encoder settings are invalid");
    return NULL;
  }
  HdaEncoder *state = calloc(1, sizeof(HdaEncoder));
  if (!state) {
    fail(NULL, "could not allocate AVIF encoder state");
    return NULL;
  }
  state->encoder = avifEncoderCreate();
  if (!state->encoder) {
    free(state);
    fail(NULL, "could not create AVIF encoder");
    return NULL;
  }
  state->width = width;
  state->height = height;
  state->encoder->codecChoice = AVIF_CODEC_CHOICE_AOM;
  state->encoder->maxThreads = 1;
  state->encoder->speed = speed;
  state->encoder->quality = quality;
  state->encoder->qualityAlpha = quality;
  state->encoder->timescale = timescale;
  state->encoder->repetitionCount = AVIF_REPETITION_COUNT_INFINITE;
  state->encoder->keyframeInterval = 0;
  return state;
}

EMSCRIPTEN_KEEPALIVE
int hda_add_rgba(HdaEncoder *state, const uint8_t *rgba, size_t byte_length, uint32_t duration) {
  if (!state || !state->encoder || state->finished) return fail(state, "AVIF encoder is not writable");
  if (!rgba || byte_length != (size_t)state->width * state->height * 4U) {
    return fail(state, "RGBA frame size does not match the AVIF canvas");
  }
  if (duration == 0 || state->frame_count >= HDA_MAX_FRAMES) {
    return fail(state, "AVIF frame count or duration exceeds its limit");
  }
  avifImage *image = avifImageCreate(state->width, state->height, 8, AVIF_PIXEL_FORMAT_YUV420);
  if (!image) return fail(state, "could not allocate AVIF image");
  image->yuvRange = AVIF_RANGE_FULL;
  image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
  image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
  image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT709;

  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, image);
  rgb.format = AVIF_RGB_FORMAT_RGBA;
  rgb.ignoreAlpha = AVIF_TRUE;
  rgb.pixels = (uint8_t *)rgba;
  rgb.rowBytes = state->width * 4U;
  avifResult result = avifImageRGBToYUV(image, &rgb);
  if (result == AVIF_RESULT_OK) {
    result = avifEncoderAddImage(state->encoder, image, duration, AVIF_ADD_IMAGE_FLAG_NONE);
  }
  avifImageDestroy(image);
  if (result != AVIF_RESULT_OK) return avif_fail(state, "could not add AVIF frame", result);
  state->frame_count += 1;
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int hda_finish(HdaEncoder *state) {
  if (!state || !state->encoder || state->finished || state->frame_count == 0) {
    return fail(state, "AVIF encoder has no finishable sequence");
  }
  avifResult result = avifEncoderFinish(state->encoder, &state->output);
  if (result != AVIF_RESULT_OK) return avif_fail(state, "could not finish AVIF sequence", result);
  if (state->output.size == 0 || state->output.size > HDA_MAX_OUTPUT_BYTES) {
    avifRWDataFree(&state->output);
    return fail(state, "Animated AVIF exceeds the 4 MiB output limit");
  }
  state->finished = 1;
  return 1;
}

EMSCRIPTEN_KEEPALIVE
const uint8_t *hda_output(const HdaEncoder *state) {
  return state && state->finished ? state->output.data : NULL;
}

EMSCRIPTEN_KEEPALIVE
size_t hda_output_size(const HdaEncoder *state) {
  return state && state->finished ? state->output.size : 0;
}

EMSCRIPTEN_KEEPALIVE
const char *hda_last_error(const HdaEncoder *state) {
  return state ? state->error : global_error;
}

EMSCRIPTEN_KEEPALIVE
void hda_destroy(HdaEncoder *state) {
  if (!state) return;
  avifRWDataFree(&state->output);
  avifEncoderDestroy(state->encoder);
  free(state);
}
