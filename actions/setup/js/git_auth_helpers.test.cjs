import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("git_auth_helpers.cjs", () => {
  let mockCore;
  let mockExec;
  let checkoutHasPersistedExtraheader;
  let overridePersistedExtraheader;
  let restorePersistedExtraheader;
  let withGitHubHostToken;
  let originalGitConfigEnvironment;

  const SERVER_URL = "https://github.com";
  const EXTRAHEADER_KEY = "http.https://github.com/.extraheader";

  beforeEach(() => {
    originalGitConfigEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)));
    for (const name of Object.keys(process.env).filter(name => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name))) {
      delete process.env[name];
    }

    mockCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn(),
    };

    mockExec = {
      exec: vi.fn().mockResolvedValue(0),
      // Exit code 5 = key absent (the most common default state).
      // This is safe for both --get-all (returns []) and --unset-all (key not found, ignored).
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 5, stdout: "", stderr: "" }),
    };

    global.core = mockCore;
    global.exec = mockExec;

    delete require.cache[require.resolve("./git_auth_helpers.cjs")];
    ({ checkoutHasPersistedExtraheader, overridePersistedExtraheader, restorePersistedExtraheader, withGitHubHostToken } = require("./git_auth_helpers.cjs"));
  });

  afterEach(() => {
    for (const name of Object.keys(process.env).filter(name => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name))) {
      delete process.env[name];
    }
    Object.assign(process.env, originalGitConfigEnvironment);
    delete global.core;
    delete global.exec;
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────
  // checkoutHasPersistedExtraheader
  // ──────────────────────────────────────────────────────

  describe("checkoutHasPersistedExtraheader", () => {
    it("should return false when no extraheader is configured", async () => {
      mockExec.getExecOutput.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });

      const result = await checkoutHasPersistedExtraheader(SERVER_URL);

      expect(result).toBe(false);
    });

    it("should return true when an extraheader is configured", async () => {
      const header = `Authorization: basic ${Buffer.from("x-access-token:tok").toString("base64")}`;
      mockExec.getExecOutput.mockResolvedValue({ exitCode: 0, stdout: header + "\n", stderr: "" });

      const result = await checkoutHasPersistedExtraheader(SERVER_URL);

      expect(result).toBe(true);
    });

    it("should strip a trailing slash from the server URL", async () => {
      mockExec.getExecOutput.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });

      await checkoutHasPersistedExtraheader("https://github.com/");

      expect(mockExec.getExecOutput).toHaveBeenCalledWith("git", ["config", "--get-all", EXTRAHEADER_KEY], expect.anything());
    });
  });

  // ──────────────────────────────────────────────────────
  // overridePersistedExtraheader
  // ──────────────────────────────────────────────────────

  describe("overridePersistedExtraheader", () => {
    it("should add an empty reset followed by the masked token", async () => {
      const token = "ghp_test_token";
      const encodedToken = Buffer.from(`x-access-token:${token}`).toString("base64");
      const expectedHeader = `Authorization: basic ${encodedToken}`;

      await overridePersistedExtraheader(SERVER_URL, token);

      expect(process.env.GIT_CONFIG_COUNT).toBe("2");
      expect(process.env.GIT_CONFIG_KEY_0).toBe(EXTRAHEADER_KEY);
      expect(process.env.GIT_CONFIG_VALUE_0).toBe("");
      expect(process.env.GIT_CONFIG_KEY_1).toBe(EXTRAHEADER_KEY);
      expect(process.env.GIT_CONFIG_VALUE_1).toBe(expectedHeader);
      expect(mockCore.setSecret).toHaveBeenCalledWith(encodedToken);
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    it("should append to and restore an existing Git environment config", async () => {
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "user.name";
      process.env.GIT_CONFIG_VALUE_0 = "Test User";
      process.env.GIT_CONFIG_KEY_1 = "preexisting-ignored-key";

      const state = await overridePersistedExtraheader(SERVER_URL, "fork-token");

      expect(process.env.GIT_CONFIG_COUNT).toBe("3");
      expect(process.env.GIT_CONFIG_KEY_1).toBe(EXTRAHEADER_KEY);
      expect(process.env.GIT_CONFIG_KEY_2).toBe(EXTRAHEADER_KEY);
      await restorePersistedExtraheader(SERVER_URL, state);
      expect(process.env.GIT_CONFIG_COUNT).toBe("1");
      expect(process.env.GIT_CONFIG_KEY_0).toBe("user.name");
      expect(process.env.GIT_CONFIG_VALUE_0).toBe("Test User");
      expect(process.env.GIT_CONFIG_KEY_1).toBe("preexisting-ignored-key");
      expect(process.env.GIT_CONFIG_KEY_2).toBeUndefined();
    });

    it("should reject an invalid existing GIT_CONFIG_COUNT before mutation", async () => {
      process.env.GIT_CONFIG_COUNT = "not-a-number";

      await expect(overridePersistedExtraheader(SERVER_URL, "fork-token")).rejects.toThrow("Invalid GIT_CONFIG_COUNT");

      expect(process.env.GIT_CONFIG_COUNT).toBe("not-a-number");
      expect(process.env.GIT_CONFIG_KEY_0).toBeUndefined();
    });

    it("should trim the token before base64-encoding", async () => {
      const token = "  ghp_padded_token  ";

      await overridePersistedExtraheader(SERVER_URL, token);

      const expected = `Authorization: basic ${Buffer.from("x-access-token:ghp_padded_token").toString("base64")}`;
      expect(process.env.GIT_CONFIG_VALUE_1).toBe(expected);
    });

    it("should warn but continue when the diagnostic config read fails", async () => {
      mockExec.getExecOutput.mockRejectedValue(new Error("git read error"));

      await overridePersistedExtraheader(SERVER_URL, "new_token");

      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining("could not read existing extraheader"));
      expect(process.env.GIT_CONFIG_COUNT).toBe("2");
    });

    it("should strip a trailing slash from the environment config key", async () => {
      await overridePersistedExtraheader("https://github.com/", "ghp_test_token");

      expect(process.env.GIT_CONFIG_KEY_0).toBe(EXTRAHEADER_KEY);
      expect(process.env.GIT_CONFIG_KEY_1).toBe(EXTRAHEADER_KEY);
    });
  });

  // ──────────────────────────────────────────────────────
  // restorePersistedExtraheader
  // ──────────────────────────────────────────────────────

  describe("restorePersistedExtraheader", () => {
    it("should not throw when previous state is null", async () => {
      await expect(restorePersistedExtraheader(SERVER_URL, null)).resolves.toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────
  // withGitHubHostToken
  // ──────────────────────────────────────────────────────

  describe("withGitHubHostToken", () => {
    it("should call the callback without any git config changes when token is empty", async () => {
      let callbackCalled = false;
      await withGitHubHostToken("", async () => {
        callbackCalled = true;
      });
      expect(callbackCalled).toBe(true);
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    it("should call the callback without any git config changes when token is undefined", async () => {
      let callbackCalled = false;
      // @ts-expect-error intentional undefined test
      await withGitHubHostToken(undefined, async () => {
        callbackCalled = true;
      });
      expect(callbackCalled).toBe(true);
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    it("should override extraheader with fork token before calling callback", async () => {
      const token = "fork-token";
      const expectedHeader = `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

      await withGitHubHostToken(token, async () => {
        expect(process.env.GIT_CONFIG_COUNT).toBe("2");
        expect(process.env.GIT_CONFIG_VALUE_0).toBe("");
        expect(process.env.GIT_CONFIG_VALUE_1).toBe(expectedHeader);
      });
    });

    it("should restore the previous environment after the callback completes", async () => {
      process.env.GIT_CONFIG_COUNT = "0";

      await withGitHubHostToken("fork-token", async () => {});

      expect(process.env.GIT_CONFIG_COUNT).toBe("0");
      expect(process.env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(process.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    });

    it("should restore the environment even when the callback throws", async () => {
      const callbackError = new Error("push failed");
      await expect(
        withGitHubHostToken("fork-token", async () => {
          throw callbackError;
        })
      ).rejects.toThrow(callbackError);

      expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(process.env.GIT_CONFIG_KEY_0).toBeUndefined();
    });

    it("should return the callback's return value", async () => {
      const result = await withGitHubHostToken("fork-token", async () => "expected-result");
      expect(result).toBe("expected-result");
    });

    it("should pass cwd to the diagnostic config read", async () => {
      const cwd = "/some/repo";

      await withGitHubHostToken("fork-token", async () => {}, cwd);

      for (const call of mockExec.getExecOutput.mock.calls) {
        expect(call[2]).toMatchObject({ cwd });
      }
    });

    it("should support nested token overrides", async () => {
      await withGitHubHostToken("outer-token", async () => {
        expect(process.env.GIT_CONFIG_COUNT).toBe("2");
        const outerHeader = process.env.GIT_CONFIG_VALUE_1;
        await withGitHubHostToken("inner-token", async () => {
          expect(process.env.GIT_CONFIG_COUNT).toBe("4");
          expect(process.env.GIT_CONFIG_VALUE_3).not.toBe(outerHeader);
        });
        expect(process.env.GIT_CONFIG_COUNT).toBe("2");
        expect(process.env.GIT_CONFIG_VALUE_1).toBe(outerHeader);
      });
      expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
    });
  });
});
