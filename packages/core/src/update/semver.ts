/** Plain MAJOR.MINOR.PATCH only (optional leading 'v'). Pre-release / build suffixes and garbage are rejected. */
const SEMVER_RE = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export type Semver = readonly [number, number, number];

export function parseVersion(v: unknown): Semver | null {
  if (typeof v !== 'string') return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Canonical form without the 'v' prefix; null when the input is not a plain version. */
export function normalizeVersion(v: unknown): string | null {
  const p = parseVersion(v);
  return p ? `${p[0]}.${p[1]}.${p[2]}` : null;
}

/** -1 / 0 / 1, or null when either side is not a plain version. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

/** true only when both versions parse and `latest` is strictly greater than `current`. */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  return compareVersions(latest, current) === 1;
}
