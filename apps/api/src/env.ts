/**
 * Process configuration.
 *
 * Read once at startup and validated there, so a missing secret stops the
 * process rather than surfacing as a confusing 500 on the first request.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required. See .env.example for what it is and where to get it.`,
    );
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),

  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://automitra:automitra@localhost:5432/automitra",

  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  /**
   * The shared secret the worker presents on the internal API.
   *
   * These endpoints serve any tenant's configuration and accept writes against
   * any call, so they are never exposed publicly -- they belong on a private
   * network, and this secret is the second lock rather than the only one.
   *
   * Deliberately required with no default. A development default would
   * eventually reach production, and the failure would be silent.
   */
  get internalApiSecret(): string {
    return required("INTERNAL_API_SECRET");
  },
};
