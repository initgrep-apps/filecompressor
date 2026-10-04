export const GS_SENTINEL_PREFIX = "fso-sidecar-acceptance-";

export const GS_INIT_SENTINEL = "fso-sidecar-acceptance-sentinel.ps";

export const GS_SEARCH_DIRS = ["Resource/Init", "lib", "Resource/Font", "fonts"];

export function sentinelNameForDir(dir) {
  if (dir === "Resource/Init") {
    return GS_INIT_SENTINEL;
  }
  return `${GS_SENTINEL_PREFIX}${dir.replace(/\//g, "-").toLowerCase()}-sentinel.ps`;
}

export function isGsSentinel(name) {
  return name.startsWith(GS_SENTINEL_PREFIX);
}

export function gsSentinelPairs(searchDirs = GS_SEARCH_DIRS) {
  return searchDirs.map((dir) => [dir, sentinelNameForDir(dir)]);
}

export function gsSentinelPaths(searchDirs = GS_SEARCH_DIRS) {
  return gsSentinelPairs(searchDirs).map(([dir, name]) => `${dir}/${name}`);
}
