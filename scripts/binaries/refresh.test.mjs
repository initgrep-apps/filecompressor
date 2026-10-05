// @vitest-environment node
import { vi, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import { createServer, get as httpGet } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const load = () => import("./refresh.mjs");
const loadLib = () => import("./lib.mjs");

const QPDF_ARM_SHA = "62e46987a30ea167cbc530ccb22690aec3d8c812ed09979a941bcee92e504b79";
const BTBN_WIN64_SHA = "683666f195f9b25f796012ca171b72735074c0411dee88e5b762e67d787ecd62";
const RIEDL_ARM_SHA = "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924";

const QPDF_RELEASE = {
  tag_name: "v12.4.2",
  assets: [
    { name: "qpdf-12.4.2-bin-macos-arm64.zip", browser_download_url: "https://example.invalid/qpdf-12.4.2-bin-macos-arm64.zip" },
    { name: "qpdf-12.4.2-bin-macos-x86_64.zip", browser_download_url: "https://example.invalid/qpdf-12.4.2-bin-macos-x86_64.zip" },
    { name: "qpdf-12.4.2-msvc64.zip", browser_download_url: "https://example.invalid/qpdf-12.4.2-msvc64.zip" },
    { name: "qpdf-12.4.2.sha256", browser_download_url: "https://example.invalid/qpdf-12.4.2.sha256" },
    { name: "qpdf-12.4.2.sha256.sigstore", browser_download_url: "https://example.invalid/qpdf-12.4.2.sha256.sigstore" },
    { name: "qpdf-12.4.2.tar.gz", browser_download_url: "https://example.invalid/qpdf-12.4.2.tar.gz" },
  ],
};

const QPDF_CHECKSUMS = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

${QPDF_ARM_SHA}  qpdf-12.4.2-bin-macos-arm64.zip
0000000000000000000000000000000000000000000000000000000000000000  qpdf-12.4.2-bin-macos-x86_64.zip
`;

const BTBN_RELEASE = {
  tag_name: "latest",
  assets: [
    { name: "checksums.sha256", browser_download_url: "https://example.invalid/checksums.sha256" },
    { name: "ffmpeg-master-latest-win64-gpl.zip", browser_download_url: "https://example.invalid/ffmpeg-master-latest-win64-gpl.zip" },
    { name: "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip", browser_download_url: "https://example.invalid/ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip" },
    { name: "ffmpeg-n9.0-latest-win64-gpl-9.0.zip", browser_download_url: "https://example.invalid/ffmpeg-n9.0-latest-win64-gpl-9.0.zip" },
    { name: "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip", browser_download_url: "https://example.invalid/ffmpeg-n9.0-latest-win64-lgpl-9.0.zip" },
    { name: "ffmpeg-n9.0-latest-winarm64-gpl-9.0.zip", browser_download_url: "https://example.invalid/ffmpeg-n9.0-latest-winarm64-gpl-9.0.zip" },
  ],
};

const BTBN_CHECKSUMS = `${BTBN_WIN64_SHA}  ffmpeg-n9.0-latest-win64-gpl-9.0.zip
9b5118393e0845efedd112db6460c89daea20485783e81ac8f0887427218c272  ffmpeg-n9.0-latest-winarm64-gpl-9.0.zip
`;

const LIBVIPS_RELEASE = {
  tag_name: "v8.18.7",
  assets: [
    { name: "vips-dev-x64-all-8.18.7.zip", browser_download_url: "https://example.invalid/vips-dev-x64-all-8.18.7.zip" },
    { name: "vips-dev-x64-web-8.18.7.zip", browser_download_url: "https://example.invalid/vips-dev-x64-web-8.18.7.zip" },
    { name: "vips-dev-x86-all-8.18.7.zip", browser_download_url: "https://example.invalid/vips-dev-x86-all-8.18.7.zip" },
  ],
};

function releaseServer(repos) {
  return async (url) => {
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url);
    if (api) {
      const release = repos[api[1]];
      if (!release) {
        return { status: 404, headers: {}, text: "" };
      }
      return { status: 200, headers: {}, text: JSON.stringify(release) };
    }
    for (const release of Object.values(repos)) {
      for (const asset of release.assets) {
        if (asset.browser_download_url === url) {
          return { status: 200, headers: {}, text: asset.text ?? "" };
        }
      }
    }
    return { status: 404, headers: {}, text: "" };
  };
}

const QPDF_TEXT = { ...QPDF_RELEASE, assets: QPDF_RELEASE.assets.map((asset) =>
  asset.name.endsWith(".sha256") && !asset.name.endsWith(".sigstore")
    ? { ...asset, text: QPDF_CHECKSUMS }
    : asset) };
const BTBN_TEXT = { ...BTBN_RELEASE, assets: BTBN_RELEASE.assets.map((asset) =>
  asset.name === "checksums.sha256" ? { ...asset, text: BTBN_CHECKSUMS } : asset) };

function riedlServer(dir = "1789931890_9.0.2", sha = RIEDL_ARM_SHA) {
  return async (url) => {
    const redirect = /\/redirect\/latest\/macos\/[a-z0-9_]+\/release\/(ffmpeg|ffprobe)\.zip$/.exec(url);
    if (redirect) {
      return {
        status: 307,
        headers: { location: `/download/macos/arm64/${dir}/${redirect[1]}.zip` },
        text: "",
      };
    }
    const sha256 = /\/download\/macos\/[a-z0-9_]+\/([0-9_.]+)\/(ffmpeg|ffprobe)\.zip\.sha256$/.exec(url);
    if (sha256) {
      return { status: 200, headers: {}, text: `${sha}  ${sha256[2]}.zip\n` };
    }
    return { status: 404, headers: {}, text: "" };
  };
}

function composed(github, riedl) {
  return async (url) => {
    const fromRiedl = await riedl(url);
    if (fromRiedl.status !== 404) {
      return fromRiedl;
    }
    return github(url);
  };
}

function macro(macArm, windows = {}) {
  return { targets: { "aarch64-apple-darwin": macArm, ...windows } };
}

async function withTree(manifest, lock, body) {
  const root = await mkdtemp(join(tmpdir(), "refresh-"));
  await writeFile(join(root, "scripts", "x"), "").catch(() => {});
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "scripts"), { recursive: true });
  const manifestPath = join(root, "scripts", "binaries.manifest.json");
  const lockPath = join(root, "scripts", "binaries.lock.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(lockPath, JSON.stringify(lock, null, 2));
  try {
    return await body({ root, manifestPath, lockPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("resolverKindFor", () => {
  it("classifies_every_source_and_refuses_to_guess", async () => {
    const { resolverKindFor } = await loadLib();

    expect(resolverKindFor({ source: "brew", formula: "vips" })).toBe("brew");
    expect(
      resolverKindFor({
        source: "url",
        url: "https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2-bin-macos-arm64.zip",
      }),
    ).toBe("github-latest");
    expect(
      resolverKindFor({
        source: "url",
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
      }),
    ).toBe("riedl-latest");
    expect(
      resolverKindFor({
        source: "url",
        url: "https://repo.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-ghostscript-10.08.0-2-any.pkg.tar.zst",
      }),
      "a vendor with no published release index must be reported as a manual pin rather than guessed at",
    ).toBe("manual");
  });
});

describe("parseChecksumList", () => {
  it("checksum_parsing_skips_pgp_signature_headers", async () => {
    const { parseChecksumList } = await loadLib();

    const map = parseChecksumList(QPDF_CHECKSUMS);

    expect(map.get("qpdf-12.4.2-bin-macos-arm64.zip")).toBe(QPDF_ARM_SHA);
    expect(
      map.size,
      "a signed checksum file has PGP armour above its digests; a parser that captures anything other than '<64-hex> <filename>' lines inflates the map and a lookup can \
       then resolve to an armour line",
    ).toBe(2);
    expect([...map.keys()].every((key) => key.endsWith(".zip")), "filenames only, never armour").toBe(
      true,
    );
  });

  it("accepts_binary_mode_star_prefixes_and_ignores_malformed_lines", async () => {
    const { parseChecksumList } = await loadLib();

    const map = parseChecksumList(
      `${"a".repeat(64)} *bin/qpdf.exe\r\nnot a digest line\r\n${"b".repeat(64)}\tqpdf.zip\n`,
    );

    expect(map.get("bin/qpdf.exe")).toBe("a".repeat(64));
    expect(map.get("qpdf.zip")).toBe("b".repeat(64));
    expect(map.size).toBe(2);
  });
});

describe("resolveGithubRelease", () => {
  it("github_resolver_picks_asset_matching_pattern_and_parses_sha", async () => {
    const { resolveGithubRelease } = await loadLib();

    const result = await resolveGithubRelease({
      repo: "qpdf/qpdf",
      assetPattern: "bin-macos-arm64\\.zip$",
      get: releaseServer({ "qpdf/qpdf": QPDF_TEXT }),
    });

    expect(result.asset.name).toBe("qpdf-12.4.2-bin-macos-arm64.zip");
    expect(
      result.sha256,
      "the digest must come from the release's own checksum asset, not be invented",
    ).toBe(QPDF_ARM_SHA);
    expect(result.tag).toBe("v12.4.2");
    expect(result.version, "qpdf tags carry the version, so expectVersion is derivable").toBe(
      "12.4.2",
    );
  });

  it("btbn_sha_parsed_from_checksums_asset", async () => {
    const { resolveGithubRelease } = await loadLib();

    const result = await resolveGithubRelease({
      repo: "BtbN/FFmpeg-Builds",
      assetPattern: "winarm64-gpl-9\\.0\\.zip$",
      get: releaseServer({ "BtbN/FFmpeg-Builds": BTBN_TEXT }),
    });

    expect(result.asset.name).toBe("ffmpeg-n9.0-latest-winarm64-gpl-9.0.zip");
    expect(
      result.sha256,
      "BtbN publishes one checksums.sha256 for the whole release; the digest for the chosen \
       asset has to be read out of it rather than from anywhere else",
    ).toBe("9b5118393e0845efedd112db6460c89daea20485783e81ac8f0887427218c272");
    expect(result.checksumSource).toBe("checksums.sha256");
    expect(
      result.version,
      "BtbN's release tag is the rolling string 'latest', so no version can be derived from it",
    ).toBeNull();
  });

  it("prefers_the_named_checksum_manifest_over_an_ambiguous_pair", async () => {
    const { resolveGithubRelease } = await loadLib();

    const both = {
      tag_name: "v1.2.3",
      assets: [
        { name: "tool-1.2.3-linux-x64.zip", browser_download_url: "https://example.invalid/tool-1.2.3-linux-x64.zip" },
        { name: "tool-1.2.3.zip", browser_download_url: "https://example.invalid/tool-1.2.3.zip" },
        { name: "checksums.sha256", browser_download_url: "https://example.invalid/checksums.sha256", text: `${"e".repeat(64)}  tool-1.2.3-linux-x64.zip\n` },
        { name: "tool-1.2.3.sha256", browser_download_url: "https://example.invalid/tool-1.2.3.sha256", text: `${"f".repeat(64)}  tool-1.2.3.zip\n` },
      ],
    };

    const result = await resolveGithubRelease({
      repo: "someone/tool",
      assetPattern: "linux-x64\\.zip$",
      get: releaseServer({ "someone/tool": both }),
    });

    expect(
      result.sha256,
      "a release carrying both checksums.sha256 and a per-release <tag>.sha256 has two \
       plausible digest files; the named manifest is the one that covers every asset, and \
       without preferring it this entry can only resolve by luck",
    ).toBe("e".repeat(64));
    expect(result.checksumSource).toBe("checksums.sha256");
  });

  it("errors_when_more_than_one_asset_matches_so_a_loose_pattern_cannot_switch_platform", async () => {
    const { resolveGithubRelease } = await loadLib();

    await expect(
      resolveGithubRelease({
        repo: "BtbN/FFmpeg-Builds",
        assetPattern: "win64-gpl",
        get: composed(releaseServer({ "BtbN/FFmpeg-Builds": BTBN_TEXT }), riedlServer()),
      }),
      "two assets match, and silently picking one would swap a build variant without anybody noticing",
    ).rejects.toThrow(/ffmpeg-n9\.0-latest-win64-gpl-shared-9\.0\.zip/);
  });

  it("missing_asset_yields_clear_error", async () => {
    const { resolveGithubRelease } = await loadLib();

    await expect(
      resolveGithubRelease({
        repo: "qpdf/qpdf",
        assetPattern: "bin-macos-riscv64\\.zip$",
        get: releaseServer({ "qpdf/qpdf": QPDF_TEXT }),
      }),
      "a pattern matching nothing must say so and name the pattern, or the operator cannot tell a typo from a vendor that dropped a platform",
    ).rejects.toThrow(/bin-macos-riscv64/);
  });

  it("requires_a_checksum_line_for_the_chosen_asset", async () => {
    const { resolveGithubRelease } = await loadLib();

    await expect(
      resolveGithubRelease({
        repo: "BtbN/FFmpeg-Builds",
        assetPattern: "win64-lgpl-9\\.0\\.zip$",
        get: composed(releaseServer({ "BtbN/FFmpeg-Builds": BTBN_TEXT }), riedlServer()),
      }),
      "the asset exists but the release does not list its digest; pinning an unverified binary is exactly what the 64-hex manifest rule exists to prevent",
    ).rejects.toThrow(/ffmpeg-n9\.0-latest-win64-lgpl-9\.0\.zip/);
  });

  it("reports_a_release_that_publishes_no_checksums_at_all", async () => {
    const { resolveGithubRelease } = await loadLib();

    await expect(
      resolveGithubRelease({
        repo: "libvips/build-win64-mxe",
        assetPattern: "vips-dev-x64-all-.*\\.zip$",
        get: releaseServer({ "libvips/build-win64-mxe": LIBVIPS_RELEASE }),
      }),
      "libvips publishes no checksum asset, so a new version cannot be auto-pinned and the operator must be told to supply the digest",
    ).rejects.toThrow(/no checksum/i);
  });

  it("rejects_a_github_entry_without_an_asset_pattern", async () => {
    const { resolveGithubRelease } = await loadLib();

    await expect(
      resolveGithubRelease({ repo: "qpdf/qpdf", assetPattern: undefined, get: releaseServer({}) }),
    ).rejects.toThrow(/assetPattern/);
  });
});

describe("resolveRiedlRelease", () => {
  async function riedlServer() {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.url === "/redirect/latest/macos/arm64/release/ffmpeg.zip") {
        if (request.method === "HEAD") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(307, {
          location: "/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        });
        response.end();
        return;
      }
      if (request.url === "/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip.sha256") {
        response.writeHead(200).end(`${RIEDL_ARM_SHA}  ffmpeg.zip\n`);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
      requests,
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it("riedl_resolver_follows_redirect_to_versioned_url_and_reads_sha", async () => {
    const { resolveRiedlRelease } = await loadLib();
    const server = await riedlServer();
    try {
      const result = await resolveRiedlRelease({
        arch: "arm64",
        binary: "ffmpeg",
        redirectBase: server.base,
        get: makeNodeGet(),
      });

      expect(result.url).toBe(
        `${server.base}/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip`,
      );
      expect(result.sha256).toBe(RIEDL_ARM_SHA);
      expect(result.version, "the version is encoded in the versioned directory name").toBe(
        "9.0.2",
      );
      expect(
        server.requests.some((request) => request.method === "GET"),
        "the vendor's redirect endpoint answers GET and 404s HEAD, so a HEAD-based resolver can never work",
      ).toBe(true);
      expect(
        server.requests.some((request) => request.method === "HEAD"),
        "resolving the redirect must not spend a HEAD request the vendor does not support",
      ).toBe(false);
      expect(
        server.requests.filter((request) => request.url.endsWith("/release/ffmpeg.zip")).length,
        "the redirect must be read as one hop, not downloaded as the artifact — a transport that follows it returns 200 with no location and the version can never be derived",
      ).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("riedl_sha_lookup_is_the_sibling_of_the_resolved_url", async () => {
    const { resolveRiedlRelease } = await loadLib();
    const seen = [];
    const result = await resolveRiedlRelease({
      arch: "arm64",
      binary: "ffprobe",
      redirectBase: "https://riedl.invalid",
      get: async (url) => {
        seen.push(url);
        if (url.endsWith("/redirect/latest/macos/arm64/release/ffprobe.zip")) {
          return { status: 307, headers: { location: "/download/macos/arm64/1700000000_9.0.1/ffprobe.zip" } };
        }
        return { status: 200, headers: {}, text: `${"f".repeat(64)}  ffprobe.zip\n` };
      },
    });

    expect(seen[0]).toBe("https://riedl.invalid/redirect/latest/macos/arm64/release/ffprobe.zip");
    expect(seen[1]).toBe("https://riedl.invalid/download/macos/arm64/1700000000_9.0.1/ffprobe.zip.sha256");
    expect(result.version).toBe("9.0.1");
    expect(result.sha256).toBe("f".repeat(64));
  });

});

describe("net", () => {
  it("refuses_to_fetch_anything_over_plain_http", async () => {
    const { getUrl } = await import("./net.mjs");

    await expect(
      getUrl("http://api.github.com/repos/qpdf/qpdf/releases/latest"),
      "the digest arrives over the same channel as the artifact, so a plain-http fetch undermines the very pin it would verify",
    ).rejects.toThrow(/https/i);
  });

  it("follows_redirects_unless_asked_to_stop_at_the_hop", async () => {
    const { followRedirects } = await import("./net.mjs");
    const asked = [];

    const stub = async (url) => {
      asked.push(url);
      if (url.endsWith("/start")) {
        return { status: 307, headers: { location: "/middle" }, text: "" };
      }
      return { status: 200, headers: {}, text: "done" };
    };

    expect((await followRedirects("https://x.invalid/start", { requestImpl: stub })).text).toBe("done");
    expect(asked, "the default must walk the chain").toEqual(["https://x.invalid/start", "https://x.invalid/middle"]);

    asked.length = 0;
    const hop = await followRedirects("https://x.invalid/start", { requestImpl: stub, follow: false });
    expect(hop.status).toBe(307);
    expect(
      hop.headers.location,
      "Riedl's latest-release URL is itself a redirect; a transport that follows it hands the resolver a 200 and the version can never be derived",
    ).toBe("/middle");
    expect(asked, "asking for one hop must not walk past it").toEqual(["https://x.invalid/start"]);
  });

  it("identifies_itself_to_the_github_api", async () => {
    const { headersFor } = await import("./net.mjs");

    expect(
      headersFor("https://api.github.com/repos/qpdf/qpdf/releases/latest")["user-agent"],
      "the GitHub REST API answers 403 to a request with no User-Agent, so omitting this makes every refresh fail against the real vendor while all fixtures pass",
    ).toBeTruthy();
    expect(headersFor("https://api.github.com/repos/qpdf/qpdf/releases/latest").accept).toBe(
      "application/vnd.github+json",
    );
    expect(
      headersFor("https://ffmpeg.martin-riedl.de/download/macos/arm64/1_9.0.2/ffmpeg.zip")[
        "user-agent"
      ],
    ).toBeTruthy();
  });
});

function makeNodeGet() {
  return (url) =>
    new Promise((resolvePromise, reject) => {
      httpGet(url, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
          }),
        );
      }).on("error", reject);
    });
}

describe("riedlArchFromUrl", () => {
  it("derives_the_arch_segment_from_the_download_path", async () => {
    const { riedlArchFromUrl } = await load();

    expect(
      riedlArchFromUrl("https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip"),
      "the arch is the segment after 'macos'; indexing the path blindly picks up 'macos'itself and builds a 404 redirect",
    ).toBe("arm64");
    expect(
      riedlArchFromUrl("https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip"),
    ).toBe("amd64");
    expect(() => riedlArchFromUrl("https://ffmpeg.martin-riedl.de/other/arm64/1_2/ffmpeg.zip")).toThrow(
      /Riedl macOS download path/,
    );
  });

  it("uses_the_manifest_arch_when_following_the_redirect", async () => {
    const { refresh } = await load();
    const seen = [];

    const intel = {
      ffmpeg: {
        source: "url",
        url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
        sha256: "1".repeat(64),
        member: "ffmpeg",
        dest: "ffmpeg",
        expectVersion: "9.0.2",
      },
    };

    await withTree(macro(intel), {
      generated: "2026-10-05T00:00:00.000Z",
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: {
            source: "url",
            version: "9.0.2",
            url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
            sha256: "1".repeat(64),
            stagedSha256: "2".repeat(64),
            date: "2026-10-05T00:00:00.000Z",
          },
        },
      },
    }, async ({ root }) => {
      await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: true,
        get: async (url) => {
          seen.push(url);
          if (url.includes("/redirect/")) {
            return { status: 307, headers: { location: "/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip" }, text: "" };
          }
          return { status: 200, headers: {}, text: `${"1".repeat(64)}  ffmpeg.zip\n` };
        },
        brewVersion: async () => null,
        runFetch: async () => {},
      });

      expect(
        seen[0],
        "an amd64 pin must ask Riedl for the amd64 build",
      ).toBe("https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip");
    });
  });
});

describe("refresh", () => {
  const macArm = {
    ffmpeg: {
      source: "url",
      url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
      sha256: RIEDL_ARM_SHA,
      member: "ffmpeg",
      dest: "ffmpeg",
      expectVersion: "9.0.2",
    },
    qpdf: {
      source: "url",
      url: "https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2-bin-macos-arm64.zip",
      sha256: QPDF_ARM_SHA,
      member: "bin/qpdf",
      lib: "lib",
      dest: "qpdf",
      expectVersion: "12.4.2",
      assetPattern: "bin-macos-arm64\\.zip$",
    },
    vips: { source: "brew", formula: "vips", dest: "vips", expectVersion: "8.18.7" },
  };
  const lock = {
    generated: "2026-10-05T00:00:00.000Z",
    targets: {
      "aarch64-apple-darwin": {
        ffmpeg: { source: "url", version: "9.0.2", url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip", sha256: RIEDL_ARM_SHA, stagedSha256: "1".repeat(64), date: "2026-10-05T00:00:00.000Z" },
        qpdf: { source: "url", version: "12.4.2", url: "https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2-bin-macos-arm64.zip", sha256: QPDF_ARM_SHA, stagedSha256: "2".repeat(64), date: "2026-10-05T00:00:00.000Z" },
        vips: { source: "brew", formula: "vips", version: "8.18.7", stagedSha256: "3".repeat(64), date: "2026-10-05T00:00:00.000Z" },
      },
    },
  };

  it("dry_run_makes_zero_writes", async () => {
    const { refresh } = await load();

    await withTree(macro(macArm), lock, async ({ root, manifestPath, lockPath }) => {
      const before = {
        manifest: await readFile(manifestPath, "utf8"),
        lock: await readFile(lockPath, "utf8"),
      };
      const fetchCalls = [];

      const result = await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: true,
        get: composed(releaseServer({ "qpdf/qpdf": QPDF_TEXT }), riedlServer()),
        brewVersion: async () => "8.18.7",
        log: () => {},
        runFetch: async () => {
          fetchCalls.push("fetch");
        },
      });

      expect(
        { manifest: await readFile(manifestPath, "utf8"), lock: await readFile(lockPath, "utf8") },
        "a dry run must leave both files byte-identical — the contract is that 'binaries:refresh --dry-run' is safe to run anywhere, including CI",
      ).toEqual(before);
      expect(fetchCalls, "a dry run reports; it does not re-fetch anything").toEqual([]);
      expect(result.wrote).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(
        result.lines.join("\n"),
        "the dry run is the report an operator reads before deciding to bump, so it has to name each source it examined rather than only the count",
      ).toContain("aarch64-apple-darwin/qpdf");
    });
  });

  it("a_dry_run_names_the_candidate_url_and_flags_an_underivable_version", async () => {
    const { refresh } = await load();

    const bumped = {
      tag_name: "latest",
      assets: [
        { name: "ffmpeg-n9.0-latest-win64-gpl-9.0.zip", browser_download_url: "https://example.invalid/ffmpeg-n9.0-latest-win64-gpl-9.0.zip" },
        { name: "checksums.sha256", browser_download_url: "https://example.invalid/checksums.sha256", text: `${"c".repeat(64)}  ffmpeg-n9.0-latest-win64-gpl-9.0.zip\n` },
      ],
    };
    const wrapped = {
      ffmpeg: {
        source: "url",
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip",
        sha256: "a".repeat(64),
        member: "ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0/bin/ffmpeg.exe",
        dest: "ffmpeg",
        expectVersion: "9.0.2",
        assetPattern: "win64-gpl-9\\.0\\.zip$",
      },
    };

    await withTree(macro({}, { "x86_64-pc-windows-msvc": wrapped }), {
      generated: "2026-10-05T00:00:00.000Z",
      targets: {
        "x86_64-pc-windows-msvc": {
          ffmpeg: {
            source: "url",
            version: "9.0.2",
            url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip",
            sha256: "a".repeat(64),
            stagedSha256: "4".repeat(64),
            date: "2026-10-05T00:00:00.000Z",
          },
        },
      },
    }, async ({ root }) => {
      const result = await refresh({
        root,
        target: "x86_64-pc-windows-msvc",
        dryRun: true,
        get: releaseServer({ "BtbN/FFmpeg-Builds": bumped }),
        brewVersion: async () => null,
        log: () => {},
        runFetch: async () => {},
      });

      const reported = result.lines.join("\n");
      expect(reported).toContain("url https://example.invalid/ffmpeg-n9.0-latest-win64-gpl-9.0.zip");
      expect(
        reported,
        "BtbN's release tag is the rolling string 'latest', so the ffmpeg version cannot be read off it and the operator must be told rather than left to assume it moved",
      ).toContain("expectVersion stays 9.0.2");
    });
  });

  it("default_mode_updates_manifest_and_lock_then_runs_fetch", async () => {
    const { refresh } = await load();

    const next = {
      tag_name: "v12.5.0",
      assets: [
        { name: "qpdf-12.5.0-bin-macos-arm64.zip", browser_download_url: "https://example.invalid/qpdf-12.5.0-bin-macos-arm64.zip" },
        { name: "qpdf-12.5.0-bin-macos-x86_64.zip", browser_download_url: "https://example.invalid/qpdf-12.5.0-bin-macos-x86_64.zip" },
        { name: "qpdf-12.5.0.sha256", browser_download_url: "https://example.invalid/qpdf-12.5.0.sha256", text: `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${"d".repeat(64)}  qpdf-12.5.0-bin-macos-arm64.zip\n` },
      ],
    };

    await withTree(macro(macArm), lock, async ({ root, manifestPath, lockPath }) => {
      const fetchCalls = [];
      const lines = [];

      const result = await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: false,
        get: composed(releaseServer({ "qpdf/qpdf": next }), riedlServer()),
        brewVersion: async () => "8.18.7",
        log: (line) => lines.push(line),
        runFetch: async (options) => {
          fetchCalls.push(options.target);
        },
      });

      const reported = result.lines.join("\n");
      expect(
        reported,
        "a refresh that rewrites pins must say what moved; an operator cannot review a change they are only told the count of",
      ).toContain("12.4.2 -> 12.5.0");
      expect(reported).toContain("qpdf-12.4.2-bin-macos-arm64.zip");
      expect(reported).toContain("qpdf-12.5.0-bin-macos-arm64.zip");
      expect(reported).toContain("d".repeat(64));

      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const entry = manifest.targets["aarch64-apple-darwin"].qpdf;

      expect(entry.url).toBe("https://example.invalid/qpdf-12.5.0-bin-macos-arm64.zip");
      expect(entry.sha256).toBe("d".repeat(64));
      expect(entry.expectVersion).toBe("12.5.0");
      expect(
        entry.member,
        "the qpdf archive is flat, so the member path must survive a version bump unchanged",
      ).toBe("bin/qpdf");
      expect(result.wrote).toBe(true);

      const writtenLock = JSON.parse(await readFile(lockPath, "utf8"));
      expect(
        writtenLock.targets["aarch64-apple-darwin"].qpdf.version,
        "the lock records what was actually fetched",
      ).toBe("12.5.0");
      expect(
        writtenLock.targets["aarch64-apple-darwin"].qpdf.stagedSha256,
        "the old artifact's staged digest describes bytes that are no longer pinned; leaving it behind makes verify compare the new download against the previous build",
      ).toBeUndefined();
      expect(writtenLock.targets["aarch64-apple-darwin"].qpdf.sha256).toBe("d".repeat(64));

      expect(
        fetchCalls,
        "a version bump is only real once the new artifact has been fetched and pinned",
      ).toEqual(["aarch64-apple-darwin"]);
    });
  });

  it("brew_resolver_reports_drift_when_versions_differ", async () => {
    const { refresh } = await load();

    await withTree(macro(macArm), lock, async ({ root }) => {
      const result = await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: true,
        get: composed(releaseServer({ "qpdf/qpdf": QPDF_TEXT }), riedlServer()),
        brewVersion: async () => "8.18.8",
        runFetch: async () => {},
      });

      const vips = result.findings.find((finding) => finding.name === "vips");

      expect(
        vips.status,
        "an installed brew formula that no longer matches the pin must be reported, never silently accepted — a drifted build is what the version gate exists to catch",
      ).toBe("drift");
      expect(vips.found).toBe("8.18.8");
      expect(vips.pinned).toBe("8.18.7");
      expect(
        vips.action,
        "expectVersion is a deliberate human decision, so the instruction has to be printed",
      ).toMatch(/expectVersion/);
    });
  });

  it("reports_brew_unchanged_when_the_installed_version_matches", async () => {
    const { refresh } = await load();

    await withTree(macro(macArm), lock, async ({ root }) => {
      const result = await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: true,
        get: composed(releaseServer({ "qpdf/qpdf": QPDF_TEXT }), riedlServer()),
        brewVersion: async () => "8.18.7",
        runFetch: async () => {},
      });

      expect(result.findings.find((finding) => finding.name === "vips").status).toBe("unchanged");
      expect(result.drift).toEqual([]);
    });
  });

  it("manual_pin_entries_report_check_vendor_instruction", async () => {
    const { refresh } = await load();

    const withGs = {
      ...macArm,
      gs: {
        source: "url",
        url: "https://repo.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-ghostscript-10.08.0-2-any.pkg.tar.zst",
        sha256: "e".repeat(64),
        member: "ucrt64/bin/gswin64c.exe",
        dest: "gs",
        expectVersion: "10.08.0",
        resources: ["share/ghostscript/10.08.0/Resource"],
      },
    };

    await withTree(macro(withGs), lock, async ({ root }) => {
      const result = await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: true,
        get: composed(releaseServer({ "qpdf/qpdf": QPDF_TEXT }), riedlServer()),
        brewVersion: async () => "8.18.7",
        runFetch: async () => {},
      });

      const gs = result.findings.find((finding) => finding.name === "gs");

      expect(gs.status).toBe("manual");
      expect(gs.action).toContain("manual pin — check vendor");
      expect(
        result.findings.some((finding) => finding.status === "error"),
        "a vendor with no index is an expected outcome, not a failure of the run",
      ).toBe(false);
    });
  });

  it("member_path_tracks_the_asset_name_when_the_archive_is_wrapped", async () => {
    const { refresh } = await load();

    const wrapped = {
      ffmpeg: {
        source: "url",
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip",
        sha256: "a".repeat(64),
        member: "ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0/bin/ffmpeg.exe",
        dest: "ffmpeg",
        expectVersion: "9.0.2",
        assetPattern: "win64-gpl-9\\.0\\.zip$",
      },
    };
    const wrappedLock = {
      generated: "2026-10-05T00:00:00.000Z",
      targets: {
        "x86_64-pc-windows-msvc": {
          ffmpeg: {
            source: "url",
            version: "9.0.2",
            url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip",
            sha256: "a".repeat(64),
            stagedSha256: "4".repeat(64),
            date: "2026-10-05T00:00:00.000Z",
          },
        },
      },
    };

    await withTree(macro({}, { "x86_64-pc-windows-msvc": wrapped }), wrappedLock, async ({ root, manifestPath }) => {
      await refresh({
        root,
        target: "x86_64-pc-windows-msvc",
        dryRun: false,
        get: composed(releaseServer({ "BtbN/FFmpeg-Builds": BTBN_TEXT }), riedlServer()),
        brewVersion: async () => null,
        runFetch: async () => {},
      });

      const entry = JSON.parse(await readFile(manifestPath, "utf8")).targets[
        "x86_64-pc-windows-msvc"
      ].ffmpeg;

      expect(
        entry.member,
        "BtbN wraps each zip in a directory named after the asset, so leaving member behind would make extract fail with a path that no longer exists",
      ).toBe("ffmpeg-n9.0-latest-win64-gpl-9.0/bin/ffmpeg.exe");
      expect(entry.sha256).toBe(BTBN_WIN64_SHA);
      expect(
        entry.expectVersion,
        "BtbN's tag is the rolling string 'latest', so the ffmpeg version cannot be derived and must be left for a human to confirm",
      ).toBe("9.0.2");
    });
  });

  it("a_vendor_that_publishes_no_digest_does_not_block_other_pins", async () => {
    const { refresh } = await load();

    const bumped = {
      tag_name: "v12.5.0",
      assets: [
        { name: "qpdf-12.5.0-bin-macos-arm64.zip", browser_download_url: "https://example.invalid/qpdf-12.5.0-bin-macos-arm64.zip" },
        { name: "qpdf-12.5.0.sha256", browser_download_url: "https://example.invalid/qpdf-12.5.0.sha256", text: `${"d".repeat(64)}  qpdf-12.5.0-bin-macos-arm64.zip\n` },
      ],
    };
    const noChecksums = {
      ...LIBVIPS_RELEASE,
      tag_name: "v8.19.0",
      assets: [
        { name: "vips-dev-x64-all-8.19.0.zip", browser_download_url: "https://example.invalid/vips-dev-x64-all-8.19.0.zip" },
      ],
    };

    const mixed = {
      ...macArm,
      vips: {
        source: "url",
        url: "https://github.com/libvips/build-win64-mxe/releases/download/v8.18.7/vips-dev-x64-all-8.18.7.zip",
        sha256: "9".repeat(64),
        member: "vips-dev-8.18/bin/vips.exe",
        dest: "vips",
        expectVersion: "8.18.7",
        assetPattern: "^vips-dev-x64-all-[\\d.]+\\.zip$",
      },
    };

    await withTree(macro(mixed), lock, async ({ root, manifestPath }) => {
      const result = await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: false,
        get: composed(
          releaseServer({ "qpdf/qpdf": bumped, "libvips/build-win64-mxe": noChecksums }),
          riedlServer(),
        ),
        brewVersion: async () => null,
        log: () => {},
        runFetch: async () => {},
      });

      expect(
        result.findings.find((finding) => finding.name === "vips").status,
        "libvips publishes no checksum asset at all — a standing condition a human must resolve, not a transient fault that should block every other engine's bump forever",
      ).toBe("manual");
      expect(result.errors).toEqual([]);
      expect(
        JSON.parse(await readFile(manifestPath, "utf8")).targets["aarch64-apple-darwin"].qpdf
          .expectVersion,
        "an unrelated engine's actionable bump must still land",
      ).toBe("12.5.0");
    });
  });

  it("a_mix_of_updates_and_failures_writes_nothing", async () => {
    const { refresh } = await load();

    const bumped = {
      tag_name: "v12.5.0",
      assets: [
        { name: "qpdf-12.5.0-bin-macos-arm64.zip", browser_download_url: "https://example.invalid/qpdf-12.5.0-bin-macos-arm64.zip" },
        { name: "qpdf-12.5.0.sha256", browser_download_url: "https://example.invalid/qpdf-12.5.0.sha256", text: `${"d".repeat(64)}  qpdf-12.5.0-bin-macos-arm64.zip\n` },
      ],
    };

    await withTree(macro(macArm), lock, async ({ root, manifestPath, lockPath }) => {
      const before = {
        manifest: await readFile(manifestPath, "utf8"),
        lock: await readFile(lockPath, "utf8"),
      };
      const fetchCalls = [];

      const result = await refresh({
        root,
        target: "aarch64-apple-darwin",
        dryRun: false,
        get: async (url) => {
          if (url.includes("api.github.com")) {
            return { status: 200, headers: {}, text: JSON.stringify(bumped) };
          }
          throw new Error("riedl unreachable");
        },
        brewVersion: async () => "8.18.7",
        runFetch: async () => {
          fetchCalls.push("fetch");
        },
      });

      expect(
        { manifest: await readFile(manifestPath, "utf8"), lock: await readFile(lockPath, "utf8") },
        "qpdf has a new version but ffmpeg could not be resolved; writing qpdf alone would leave the manifest pinned to a build whose sibling engines were never re-checked, and a lock \
         claiming a bump that was never fetched",
      ).toEqual(before);
      expect(result.findings.some((finding) => finding.status === "error")).toBe(true);
      expect(
        fetchCalls,
        "re-fetching after a partial resolve stages the new binary against a lock that never recorded it",
      ).toEqual([]);
    });
  });
});

describe("manifest validation", () => {
  it("accepts_a_well_formed_asset_pattern_and_rejects_a_broken_one", async () => {
    const { validateManifest } = await loadLib();

    const base = {
      targets: {
        "aarch64-apple-darwin": {
          qpdf: {
            source: "url",
            url: "https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2-bin-macos-arm64.zip",
            sha256: "a".repeat(64),
            member: "bin/qpdf",
            dest: "qpdf",
            expectVersion: "12.4.2",
          },
        },
      },
    };

    expect(() => validateManifest(base)).not.toThrow();
    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            qpdf: { ...base.targets["aarch64-apple-darwin"].qpdf, assetPattern: "bin-macos-arm64\\.zip$" },
          },
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            qpdf: { ...base.targets["aarch64-apple-darwin"].qpdf, assetPattern: "bin-macos-arm64(\\.zip$" },
          },
        },
      }),
      "a pattern that does not compile would otherwise only fail later, inside the resolver, with no indication of which manifest row is at fault",
    ).toThrow(/assetPattern.*not a valid regex/s);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            qpdf: { ...base.targets["aarch64-apple-darwin"].qpdf, assetPattern: "" },
          },
        },
      }),
    ).toThrow(/assetPattern/);
  });
});

describe("argument handling", () => {
  it("dry_run_is_a_flag_refresh_owns_and_no_other_command_claims_it", async () => {
    const { parseRefreshArgs } = await load();
    const lib = await loadLib();

    expect(parseRefreshArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseRefreshArgs(["--dry-run", "--target", "aarch64-apple-darwin"]).target).toBe(
      "aarch64-apple-darwin",
    );

    expect(
      () => lib.parseArgs(["--dry-run"]),
      "letting the shared parser accept --dry-run would mean 'binaries:fetch --dry-run'silently did a real fetch",
    ).toThrow(/unknown flag/);
  });

  it("rejects_dry_run_with_a_stray_value", async () => {
    const { parseRefreshArgs } = await load();

    expect(() => parseRefreshArgs(["--dry-run=yes"])).toThrow(/--dry-run/);
  });
});