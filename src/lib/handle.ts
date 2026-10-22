/** Display handle derived from the stable Better Auth ID: short enough for a feed line, never used as an identifier. */
export const handleFor = (userId: string) => `@xi-${userId.slice(0, 8)}`;

/** Compare display handles and generator slugs without depending on the @ prefix. */
export const normalizeHandle = (handle: string) => handle.trim().replace(/^@/, "").toLowerCase();
