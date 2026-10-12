/**
 * Env readers shared by the broker's and the audit sink's config loaders, so
 * both fail the same way on a missing or malformed value.
 */

export function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value.trim();
}

export function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}
