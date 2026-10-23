import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { AvatarError, MAX_AVATAR_BYTES, normalizeAvatar, readAvatarUpload } from "../src/lib/avatars";

const create = () => sharp({ create: { width: 80, height: 60, channels: 3, background: "#28734e" } });

test("avatars: decode supported formats, normalize to WebP and remove metadata", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const input = await create()[format]().withMetadata().toBuffer();
    const output = await normalizeAvatar(input, `image/${format}`);
    const meta = await sharp(output).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 512); assert.equal(meta.height, 512);
    assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined);
    assert.equal(meta.pages ?? 1, 1);
  }
});

test("avatars: reject spoofed MIME, SVG, corrupt, empty, oversized and excessive-pixel inputs", async () => {
  const cases: [Buffer, string][] = [
    [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>"), "image/png"],
    [Buffer.from("<script>alert(1)</script>"), "image/jpeg"],
    [await create().png().toBuffer(), "image/jpeg"],
    [Buffer.alloc(0), "image/png"],
    [Buffer.alloc(MAX_AVATAR_BYTES + 1), "image/png"],
    [await create().png().toBuffer(), "image/svg+xml"],
    [await sharp({ create: { width: 4097, height: 4097, channels: 3, background: "white" } }).png().toBuffer(), "image/png"],
  ];
  for (const [bytes, type] of cases) await assert.rejects(normalizeAvatar(bytes, type), AvatarError);
  const frames = Buffer.concat([Buffer.alloc(20 * 20 * 3, 0), Buffer.alloc(20 * 20 * 3, 255)]);
  const animated = await sharp(frames, { raw: { width: 20, height: 40, channels: 3, pageHeight: 20 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  await assert.rejects(normalizeAvatar(animated, "image/webp"), AvatarError);
});

test("avatars: actual streamed bytes are limited even without Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  const request = new Request("http://localhost/upload", {
    method: "PUT", headers: { "Content-Type": "image/png" }, body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(readAvatarUpload(request), (error: unknown) => error instanceof AvatarError && error.status === 413);
  assert.equal(cancelled, true);
});
