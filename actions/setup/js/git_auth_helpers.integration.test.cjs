// Integration tests for git_auth_helpers.cjs.
//
// These tests use real git repositories so environment overlays interact with
// global, local, and included config exactly as Git processes them.
// Global git config is isolated via GIT_CONFIG_GLOBAL so no test can pollute
// the developer's real ~/.gitconfig.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFile, spawnSync } from "child_process";
import { createRequire } from "module";
import { promisify } from "util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const SERVER_URL = "https://github.com";
const EXTRAHEADER_KEY = `http.${SERVER_URL}/.extraheader`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a real git command with GIT_CONFIG_GLOBAL pointing at the isolated
 * config file.  Returns the spawnSync result; never throws on non-zero exit.
 */
function runGit(args, repoDir, globalConfigPath) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath };
  const result = spawnSync("git", args, { encoding: "utf8", cwd: repoDir, env });
  if (result.error) throw result.error;
  return result;
}

/**
 * Create a temporary directory containing:
 *   - a bare global gitconfig file (.gitconfig-global)
 *   - an initialised git repository (repo/)
 *
 * Returns { repoDir, globalConfigPath }.
 */
function createIsolatedRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const globalConfigPath = path.join(root, ".gitconfig-global");
  // Minimal global config so git commits work
  fs.writeFileSync(globalConfigPath, "[user]\n\tname = Test User\n\temail = test@example.com\n");
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir);
  runGit(["init", "-q"], repoDir, globalConfigPath);
  fs.writeFileSync(path.join(repoDir, "README.md"), "init\n");
  runGit(["add", "."], repoDir, globalConfigPath);
  runGit(["commit", "-q", "-m", "init"], repoDir, globalConfigPath);
  return { root, repoDir, globalConfigPath };
}

/**
 * Build the exec API passed to git_auth_helpers.cjs.
 * Every git subprocess it spawns carries GIT_CONFIG_GLOBAL so that --global
 * operations hit the isolated config file rather than the real user config.
 */
function createExecApi(repoDir, globalConfigPath) {
  function spawnGit(args, apiOptions = {}) {
    const cwd = apiOptions.cwd || repoDir;
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath };
    return spawnSync("git", args, { encoding: "utf8", cwd, env });
  }
  return {
    async exec(cmd, args = [], options = {}) {
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);
      const r = spawnGit(args, options);
      if (r.error) throw r.error;
      if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
      }
      return r.status;
    },
    async getExecOutput(cmd, args = [], options = {}) {
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);
      const r = spawnGit(args, options);
      if (r.error) throw r.error;
      if (r.status !== 0 && !options.ignoreReturnCode) {
        throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
      }
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/**
 * Read all values for key from a specific scope (or all scopes if scopeFlag
 * is omitted) using a real git process.
 */
function readConfigValues(key, scopeFlag, repoDir, globalConfigPath) {
  const args = scopeFlag ? ["config", scopeFlag, "--get-all", key] : ["config", "--get-all", key];
  const r = runGit(args, repoDir, globalConfigPath);
  // exit 5 = key absent; any other non-zero = error
  if (r.status !== 0) return [];
  return r.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Read the headers Git will effectively send. An empty extraheader resets all
 * inherited values that precede it.
 */
function readEffectiveConfigValues(key, repoDir, globalConfigPath) {
  const r = runGit(["config", "--get-all", key], repoDir, globalConfigPath);
  if (r.status !== 0) return [];
  const values = r.stdout.replace(/\r/g, "").split("\n");
  if (values.at(-1) === "") values.pop();
  const resetIndex = values.lastIndexOf("");
  return values.slice(resetIndex + 1).filter(Boolean);
}

/**
 * Write a single value to the given scope.
 */
function writeConfigValue(key, value, scopeFlag, repoDir, globalConfigPath) {
  const r = runGit(["config", scopeFlag, "--add", key, value], repoDir, globalConfigPath);
  if (r.status !== 0) throw new Error(`git config write failed: ${r.stderr}`);
}

/**
 * Persist a credential using the actions/checkout v7 layout: the header lives
 * in a RUNNER_TEMP file referenced by a repository-local includeIf entry.
 */
function writeCheckoutV7Credential(header, root, repoDir, globalConfigPath, serverUrl = SERVER_URL) {
  const credentialsPath = path.join(root, "git-credentials-12345678-1234-1234-1234-123456789abc.config");
  fs.writeFileSync(credentialsPath, `[http "${serverUrl}/"]\n\textraheader = ${header}\n`);

  const gitDir = path.join(repoDir, ".git").replace(/\\/g, "/");
  const includeKey = `includeIf.gitdir:${gitDir}.path`;
  const r = runGit(["config", "--local", "--add", includeKey, credentialsPath], repoDir, globalConfigPath);
  if (r.status !== 0) throw new Error(`git config includeIf write failed: ${r.stderr}`);

  return { credentialsPath, includeKey };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("git_auth_helpers.cjs git integration", () => {
  let repoDir;
  let globalConfigPath;
  let root;
  let mockCore;
  let overridePersistedExtraheader;
  let restorePersistedExtraheader;
  let withGitHubHostToken;

  let origGithubServerUrl;
  let origRunnerTemp;
  let originalGitConfigEnvironment;

  beforeEach(() => {
    ({ root, repoDir, globalConfigPath } = createIsolatedRepo("git-auth-helpers-it-"));

    originalGitConfigEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)));
    for (const name of Object.keys(process.env).filter(name => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name))) {
      delete process.env[name];
    }

    origGithubServerUrl = process.env.GITHUB_SERVER_URL;
    origRunnerTemp = process.env.RUNNER_TEMP;
    process.env.GITHUB_SERVER_URL = SERVER_URL;
    process.env.RUNNER_TEMP = root;

    mockCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn(),
    };

    global.core = mockCore;
    global.exec = createExecApi(repoDir, globalConfigPath);

    delete require.cache[require.resolve("./git_auth_helpers.cjs")];
    ({ overridePersistedExtraheader, restorePersistedExtraheader, withGitHubHostToken } = require("./git_auth_helpers.cjs"));
  });

  afterEach(() => {
    for (const name of Object.keys(process.env).filter(name => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name))) {
      delete process.env[name];
    }
    Object.assign(process.env, originalGitConfigEnvironment);
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    if (origGithubServerUrl !== undefined) {
      process.env.GITHUB_SERVER_URL = origGithubServerUrl;
    } else {
      delete process.env.GITHUB_SERVER_URL;
    }
    if (origRunnerTemp !== undefined) {
      process.env.RUNNER_TEMP = origRunnerTemp;
    } else {
      delete process.env.RUNNER_TEMP;
    }
    delete global.core;
    delete global.exec;
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────
  // overridePersistedExtraheader
  // ──────────────────────────────────────────────────────

  describe("overridePersistedExtraheader", () => {
    it("overrides a global token without mutating file-backed config", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      const forkToken = "fork-token-123";
      const expectedForkHeader = `Authorization: basic ${Buffer.from(`x-access-token:${forkToken}`).toString("base64")}`;

      writeConfigValue(EXTRAHEADER_KEY, upstreamHeader, "--global", repoDir, globalConfigPath);

      await overridePersistedExtraheader(SERVER_URL, forkToken, repoDir);

      expect(readConfigValues(EXTRAHEADER_KEY, "--global", repoDir, globalConfigPath)).toEqual([upstreamHeader]);
      expect(readConfigValues(EXTRAHEADER_KEY, "--local", repoDir, globalConfigPath)).toEqual([]);
      expect(readEffectiveConfigValues(EXTRAHEADER_KEY, repoDir, globalConfigPath)).toEqual([expectedForkHeader]);
    });

    it("returns environment state and still writes the fork token when no header exists", async () => {
      const forkToken = "fork-only";
      const expectedForkHeader = `Authorization: basic ${Buffer.from(`x-access-token:${forkToken}`).toString("base64")}`;

      const previous = await overridePersistedExtraheader(SERVER_URL, forkToken, repoDir);

      expect(previous.previousEnvironment.GIT_CONFIG_COUNT).toBeUndefined();
      expect(readEffectiveConfigValues(EXTRAHEADER_KEY, repoDir, globalConfigPath)).toEqual([expectedForkHeader]);
    });

    it("does not mutate checkout v7 config when the environment count is invalid", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      const { credentialsPath, includeKey } = writeCheckoutV7Credential(upstreamHeader, root, repoDir, globalConfigPath);
      process.env.GIT_CONFIG_COUNT = "invalid";

      await expect(overridePersistedExtraheader(SERVER_URL, "fork-token", repoDir)).rejects.toThrow("Invalid GIT_CONFIG_COUNT");
      delete process.env.GIT_CONFIG_COUNT;
      expect(readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath)).toEqual([upstreamHeader]);
      expect(readConfigValues(EXTRAHEADER_KEY, "--local", repoDir, globalConfigPath)).toEqual([]);
      expect(readConfigValues(includeKey, "--local", repoDir, globalConfigPath)).toEqual([credentialsPath]);
    });
  });

  // ──────────────────────────────────────────────────────
  // restorePersistedExtraheader
  // ──────────────────────────────────────────────────────

  describe("restorePersistedExtraheader", () => {
    it("restores only the environment variables changed by override", async () => {
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "user.email";
      process.env.GIT_CONFIG_VALUE_0 = "test@example.com";

      const state = await overridePersistedExtraheader(SERVER_URL, "fork-token", repoDir);
      await restorePersistedExtraheader(SERVER_URL, state, repoDir);

      expect(process.env.GIT_CONFIG_COUNT).toBe("1");
      expect(process.env.GIT_CONFIG_KEY_0).toBe("user.email");
      expect(process.env.GIT_CONFIG_VALUE_0).toBe("test@example.com");
      expect(process.env.GIT_CONFIG_KEY_1).toBeUndefined();
      expect(process.env.GIT_CONFIG_VALUE_1).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────
  // withGitHubHostToken — multi-cycle regression
  // ──────────────────────────────────────────────────────

  describe("withGitHubHostToken", () => {
    it("does not accumulate extraheader values across multiple override/restore cycles", async () => {
      // Simulates a direct upstream credential while two fork-token callbacks
      // run in sequence.
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      writeConfigValue(EXTRAHEADER_KEY, upstreamHeader, "--global", repoDir, globalConfigPath);

      const capturedCounts = [];
      mockCore.info.mockImplementation(msg => {
        const m = msg.match(/read (\d+) existing extraheader value/);
        if (m) capturedCounts.push(Number(m[1]));
      });

      // Two full override/restore cycles (simulates two retries)
      for (let i = 0; i < 2; i++) {
        await withGitHubHostToken("fork-token", async () => {}, repoDir);
      }

      // Environment overlays leave file-backed config unchanged.
      expect(capturedCounts).toEqual([1, 1]);
    });

    it("leaves exactly one extraheader value active inside the callback", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      const forkToken = "fork-callback-check";
      const expectedForkHeader = `Authorization: basic ${Buffer.from(`x-access-token:${forkToken}`).toString("base64")}`;
      writeConfigValue(EXTRAHEADER_KEY, upstreamHeader, "--global", repoDir, globalConfigPath);

      let valuesInsideCallback;
      await withGitHubHostToken(
        forkToken,
        async () => {
          valuesInsideCallback = readEffectiveConfigValues(EXTRAHEADER_KEY, repoDir, globalConfigPath);
        },
        repoDir
      );

      // Exactly one Authorization header must be active during the callback
      expect(valuesInsideCallback).toEqual([expectedForkHeader]);
    });

    it("restores exactly one extraheader value after the callback completes", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      writeConfigValue(EXTRAHEADER_KEY, upstreamHeader, "--global", repoDir, globalConfigPath);

      await withGitHubHostToken("fork-token", async () => {}, repoDir);

      // Restore preserves the original global scope.
      const allValues = readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath);
      expect(allValues).toEqual([upstreamHeader]);
      expect(readConfigValues(EXTRAHEADER_KEY, "--global", repoDir, globalConfigPath)).toEqual([upstreamHeader]);
      expect(readConfigValues(EXTRAHEADER_KEY, "--local", repoDir, globalConfigPath)).toEqual([]);
    });

    it("restores the config even when the callback throws", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      writeConfigValue(EXTRAHEADER_KEY, upstreamHeader, "--global", repoDir, globalConfigPath);

      await expect(
        withGitHubHostToken(
          "fork-token",
          async () => {
            throw new Error("simulated callback failure");
          },
          repoDir
        )
      ).rejects.toThrow("simulated callback failure");

      const allValues = readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath);
      expect(allValues).toEqual([upstreamHeader]);
    });

    it("temporarily replaces an actions/checkout v7 includeIf credential", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      const forkToken = "fork-include-check";
      const expectedForkHeader = `Authorization: basic ${Buffer.from(`x-access-token:${forkToken}`).toString("base64")}`;
      const { credentialsPath, includeKey } = writeCheckoutV7Credential(upstreamHeader, root, repoDir, globalConfigPath);

      expect(readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath)).toEqual([upstreamHeader]);

      const valuesInsideCallbacks = [];
      for (let cycle = 0; cycle < 2; cycle++) {
        await withGitHubHostToken(
          forkToken,
          async () => {
            valuesInsideCallbacks.push(readEffectiveConfigValues(EXTRAHEADER_KEY, repoDir, globalConfigPath));
            expect(readConfigValues(includeKey, "--local", repoDir, globalConfigPath)).toEqual([credentialsPath]);
          },
          repoDir
        );
      }

      expect(valuesInsideCallbacks).toEqual([[expectedForkHeader], [expectedForkHeader]]);
      expect(readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath)).toEqual([upstreamHeader]);
      expect(readConfigValues(EXTRAHEADER_KEY, "--local", repoDir, globalConfigPath)).toEqual([]);
      expect(readConfigValues(includeKey, "--local", repoDir, globalConfigPath)).toEqual([credentialsPath]);
      expect(fs.existsSync(credentialsPath)).toBe(true);
    });

    it("sends only the fork Authorization header on the wire", async () => {
      const requests = [];
      const server = http.createServer((request, response) => {
        const authorizationHeaders = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          if (request.rawHeaders[index].toLowerCase() === "authorization") {
            authorizationHeaders.push(request.rawHeaders[index + 1]);
          }
        }
        requests.push(authorizationHeaders);
        response.statusCode = 401;
        response.end();
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

      try {
        const address = server.address();
        const serverUrl = `http://127.0.0.1:${address.port}`;
        const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
        const forkToken = "fork-wire-check";
        const expectedAuthorization = `basic ${Buffer.from(`x-access-token:${forkToken}`).toString("base64")}`;
        writeCheckoutV7Credential(upstreamHeader, root, repoDir, globalConfigPath, serverUrl);
        process.env.GITHUB_SERVER_URL = serverUrl;

        await withGitHubHostToken(
          forkToken,
          async () => {
            await expect(
              execFileAsync("git", ["ls-remote", `${serverUrl}/repo.git`], {
                cwd: repoDir,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
              })
            ).rejects.toThrow();
          },
          repoDir
        );

        expect(requests.length).toBeGreaterThan(0);
        expect(requests[0]).toEqual([expectedAuthorization]);
        expect(requests.every(headers => headers.length <= 1)).toBe(true);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });

    it("restores an actions/checkout v7 includeIf credential when the callback throws", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      const { credentialsPath, includeKey } = writeCheckoutV7Credential(upstreamHeader, root, repoDir, globalConfigPath);

      await expect(
        withGitHubHostToken(
          "fork-token",
          async () => {
            throw new Error("simulated callback failure");
          },
          repoDir
        )
      ).rejects.toThrow("simulated callback failure");

      expect(readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath)).toEqual([upstreamHeader]);
      expect(readConfigValues(EXTRAHEADER_KEY, "--local", repoDir, globalConfigPath)).toEqual([]);
      expect(readConfigValues(includeKey, "--local", repoDir, globalConfigPath)).toEqual([credentialsPath]);
    });

    it("preserves unrelated includeIf values and their order", async () => {
      const upstreamHeader = `Authorization: basic ${Buffer.from("x-access-token:upstream").toString("base64")}`;
      const ghesHeader = `Authorization: basic ${Buffer.from("x-access-token:ghes").toString("base64")}`;
      const ghesKey = "http.https://ghe.example.com/.extraheader";
      const { credentialsPath, includeKey } = writeCheckoutV7Credential(upstreamHeader, root, repoDir, globalConfigPath);
      const ghesCredentialsPath = path.join(root, "git-credentials-87654321-4321-4321-4321-cba987654321.config");
      fs.writeFileSync(ghesCredentialsPath, `[http "https://ghe.example.com/"]\n\textraheader = ${ghesHeader}\n`);
      const addResult = runGit(["config", "--local", "--add", includeKey, ghesCredentialsPath], repoDir, globalConfigPath);
      if (addResult.status !== 0) throw new Error(`git config includeIf write failed: ${addResult.stderr}`);

      const originalIncludeValues = [credentialsPath, ghesCredentialsPath];
      expect(readConfigValues(includeKey, "--local", repoDir, globalConfigPath)).toEqual(originalIncludeValues);

      await withGitHubHostToken(
        "fork-token",
        async () => {
          expect(readConfigValues(includeKey, "--local", repoDir, globalConfigPath)).toEqual(originalIncludeValues);
          expect(readConfigValues(ghesKey, null, repoDir, globalConfigPath)).toEqual([ghesHeader]);
        },
        repoDir
      );

      expect(readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath)).toEqual([upstreamHeader]);
      expect(readConfigValues(ghesKey, null, repoDir, globalConfigPath)).toEqual([ghesHeader]);
      expect(readConfigValues(includeKey, "--local", repoDir, globalConfigPath)).toEqual(originalIncludeValues);
    });

    it("handles a direct extraheader and checkout v7 include together", async () => {
      const includedHeader = `Authorization: basic ${Buffer.from("x-access-token:included").toString("base64")}`;
      const directHeader = `Authorization: basic ${Buffer.from("x-access-token:direct").toString("base64")}`;
      const forkToken = "fork-mixed-state";
      const expectedForkHeader = `Authorization: basic ${Buffer.from(`x-access-token:${forkToken}`).toString("base64")}`;
      writeCheckoutV7Credential(includedHeader, root, repoDir, globalConfigPath);
      writeConfigValue(EXTRAHEADER_KEY, directHeader, "--global", repoDir, globalConfigPath);

      expect(readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath)).toHaveLength(2);

      await withGitHubHostToken(
        forkToken,
        async () => {
          expect(readEffectiveConfigValues(EXTRAHEADER_KEY, repoDir, globalConfigPath)).toEqual([expectedForkHeader]);
        },
        repoDir
      );

      expect(readConfigValues(EXTRAHEADER_KEY, null, repoDir, globalConfigPath).sort()).toEqual([directHeader, includedHeader].sort());
    });
  });
});
