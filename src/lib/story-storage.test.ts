import assert from "node:assert/strict";
import test from "node:test";

import { decodeStoryImage } from "./story-storage.ts";

function vp8xImage(width: number, height: number): string {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString("base64");
}

test("story covers require the exact optimized WebP dimensions", () => {
  const result = decodeStoryImage(vp8xImage(1280, 460), "image/webp", "detail");
  assert.equal(result.mimeType, "image/webp");

  assert.throws(
    () => decodeStoryImage(vp8xImage(1279, 460), "image/webp", "detail"),
    /exactly 1280 × 460/,
  );
});

test("stories display covers use their own dimensions", () => {
  assert.doesNotThrow(
    () => decodeStoryImage(vp8xImage(1218, 580), "image/webp", "listing"),
  );
  assert.throws(
    () => decodeStoryImage(vp8xImage(1280, 460), "image/webp", "listing"),
    /exactly 1218 × 580/,
  );
});
