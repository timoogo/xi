import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { getAppDatabase } from "./auth";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const FORMATS: Record<string, string> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
const FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;
const PREFIX = "/api/avatars/";

export class AvatarError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function avatarDirectory() {
  return join(dirname(resolve(process.env.AUTH_DATABASE_PATH || "./data/xi-auth.sqlite")), "avatars");
}

/** Bound the actual stream, not just the untrusted Content-Length header. */
export async function readAvatarUpload(request: Request) {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!FORMATS[type]) throw new AvatarError("Choisissez une image JPEG, PNG ou WebP.", 415);
  if (Number(request.headers.get("content-length")) > MAX_AVATAR_BYTES) throw new AvatarError("L’image dépasse la limite de 5 Mo.", 413);
  if (!request.body) throw new AvatarError("Choisissez une image.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_AVATAR_BYTES) {
        await reader.cancel();
        throw new AvatarError("L’image dépasse la limite de 5 Mo.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return normalizeAvatar(Buffer.concat(chunks), type);
}

/** Full decoding rejects corrupt files. Reencoding strips EXIF/GPS and trailing payloads. */
export async function normalizeAvatar(input: Buffer, type: string) {
  if (!input.length) throw new AvatarError("L’image est vide.");
  if (input.length > MAX_AVATAR_BYTES) throw new AvatarError("L’image dépasse la limite de 5 Mo.", 413);
  if (!FORMATS[type]) throw new AvatarError("Choisissez une image JPEG, PNG ou WebP.", 415);
  try {
    const image = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "warning" }).timeout({ seconds: 5 });
    const meta = await image.metadata();
    if (meta.format !== FORMATS[type] || (meta.pages ?? 1) !== 1) throw new AvatarError("Utilisez une image JPEG, PNG ou WebP non animée.", 415);
    return await image.rotate().resize(512, 512, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
  } catch (error) {
    if (error instanceof AvatarError) throw error;
    throw new AvatarError("Image invalide ou trop grande (16 mégapixels maximum).");
  }
}

async function removeUnused(image: string | null) {
  if (!image?.startsWith(PREFIX)) return;
  const file = image.slice(PREFIX.length);
  if (!FILE.test(file)) return;
  // Never remove another user's current avatar, even if an old URL was shared.
  if (getAppDatabase().prepare('SELECT 1 FROM "user" WHERE image = ? LIMIT 1').get(image)) return;
  await unlink(join(avatarDirectory(), file)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Avatar cleanup failed");
  });
}

/** The session supplies userId. Better Auth's existing image field is the sole source of truth.
 * A synchronous transaction serializes replacements/deletions across server processes.
 * Cookie caching is disabled in auth.ts, so Better Auth reads the updated user on every request.
 */
export async function replaceAvatar(userId: string, bytes: Buffer | null) {
  const db = getAppDatabase();
  let image: string | null = null;
  if (bytes) {
    await mkdir(avatarDirectory(), { recursive: true, mode: 0o700 });
    const file = `${randomUUID()}.webp`;
    await writeFile(join(avatarDirectory(), file), bytes, { flag: "wx", mode: 0o600 });
    image = PREFIX + file;
  }
  let previous: string | null;
  try {
    previous = db.transaction(() => {
      const user = db.prepare('SELECT image FROM "user" WHERE id = ?').get(userId) as { image: string | null } | undefined;
      if (!user) throw new AvatarError("Session expirée.", 401);
      db.prepare('UPDATE "user" SET image = ?, updatedAt = ? WHERE id = ?').run(image, Date.now(), userId);
      return user.image;
    })();
  } catch (error) {
    await removeUnused(image);
    throw error;
  }
  await removeUnused(previous);
  return image;
}

export async function readAvatar(file: string) {
  if (!FILE.test(file)) return null;
  if (!getAppDatabase().prepare('SELECT 1 FROM "user" WHERE image = ? LIMIT 1').get(PREFIX + file)) return null;
  try {
    const handle = await open(join(avatarDirectory(), file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile(); } finally { await handle.close(); }
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
