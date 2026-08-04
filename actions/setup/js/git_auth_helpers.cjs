// @ts-check
/// <reference types="@actions/github-script" />
// This module relies on the `exec` and `core` globals injected by github-script at runtime.
// All callers must ensure these globals are set before invoking any helper.

const { getErrorMessage } = require("./error_helpers.cjs");

/**
 * @typedef {{ previousEnvironment: Record<string, string | undefined> }} ExtraheaderState
 */

/**
 * Normalize a server URL by stripping any trailing slash so the git config key
 * matches exactly what actions/checkout writes (e.g. `http.https://github.com/.extraheader`).
 *
 * @param {string} serverUrl
 * @returns {string}
 */
function normalizeServerUrl(serverUrl) {
  return serverUrl.replace(/\/+$/, "");
}

/**
 * Get all configured values for http.<serverUrl>/.extraheader.
 * Throws if `exec.getExecOutput` itself throws (e.g. git not available).
 * Returns an empty array when the key is absent (exit code ≠ 0).
 *
 * @param {string} serverUrl
 * @param {string} [cwd] - Optional working directory for the git config command
 * @returns {Promise<string[]>}
 */
async function getExtraheaderValues(serverUrl, cwd) {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const execOptions = cwd ? { silent: true, ignoreReturnCode: true, cwd } : { silent: true, ignoreReturnCode: true };
  const result = await exec.getExecOutput("git", ["config", "--get-all", `http.${normalizedUrl}/.extraheader`], execOptions);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Determine whether checkout persisted an extraheader credential.
 * Returns false on any read error (safe default: assume no persisted credential).
 *
 * @param {string} serverUrl
 * @returns {Promise<boolean>}
 */
async function checkoutHasPersistedExtraheader(serverUrl) {
  try {
    const values = await getExtraheaderValues(serverUrl);
    return values.length > 0;
  } catch {
    return false;
  }
}

/**
 * Add a command-scope extraheader reset and token using Git's environment
 * config protocol. File-backed config and includeIf entries remain untouched.
 *
 * @param {string} serverUrl
 * @param {string} token
 * @param {string} [cwd] - Optional working directory for the git config command
 * @returns {Promise<ExtraheaderState>}
 */
async function overridePersistedExtraheader(serverUrl, token, cwd) {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  try {
    const existingValues = await getExtraheaderValues(serverUrl, cwd);
    core.info(`git_auth_helpers: read ${existingValues.length} existing extraheader value(s) for ${normalizedUrl}`);
  } catch (err) {
    core.warning(`git_auth_helpers: could not read existing extraheader values: ${getErrorMessage(err)}`);
  }

  const key = `http.${normalizedUrl}/.extraheader`;
  core.info(`git_auth_helpers: overriding http.${normalizedUrl}/.extraheader with CI trigger token`);
  const tokenBase64 = Buffer.from(`x-access-token:${token.trim()}`).toString("base64");
  core.setSecret(tokenBase64);
  const authHeader = `Authorization: basic ${tokenBase64}`;

  const countValue = process.env.GIT_CONFIG_COUNT;
  if (countValue !== undefined && !/^\d+$/.test(countValue)) {
    throw new Error(`Invalid GIT_CONFIG_COUNT value: ${countValue}`);
  }
  const count = countValue === undefined ? 0 : Number(countValue);
  if (!Number.isSafeInteger(count)) {
    throw new Error(`GIT_CONFIG_COUNT exceeds the safe integer range: ${countValue}`);
  }

  const variableNames = [`GIT_CONFIG_KEY_${count}`, `GIT_CONFIG_VALUE_${count}`, `GIT_CONFIG_KEY_${count + 1}`, `GIT_CONFIG_VALUE_${count + 1}`, "GIT_CONFIG_COUNT"];
  /** @type {Record<string, string | undefined>} */
  const previousEnvironment = {};
  for (const name of variableNames) {
    previousEnvironment[name] = process.env[name];
  }

  // An empty command-scope extraheader resets values inherited from every
  // file-backed scope. The following value is therefore the only header Git
  // sends, including when actions/checkout v7 uses includeIf credentials.
  process.env[`GIT_CONFIG_KEY_${count}`] = key;
  process.env[`GIT_CONFIG_VALUE_${count}`] = "";
  process.env[`GIT_CONFIG_KEY_${count + 1}`] = key;
  process.env[`GIT_CONFIG_VALUE_${count + 1}`] = authHeader;
  process.env.GIT_CONFIG_COUNT = String(count + 2);

  core.info(`git_auth_helpers: extraheader override applied`);
  return { previousEnvironment };
}

/**
 * Restore the Git environment variables replaced by
 * overridePersistedExtraheader.
 *
 * @param {string} serverUrl
 * @param {ExtraheaderState | null | undefined} previousState
 * @param {string} [cwd] - Optional working directory for the git config command
 * @returns {Promise<void>}
 */
async function restorePersistedExtraheader(serverUrl, previousState, cwd) {
  if (!previousState) {
    return;
  }

  const entries = Object.entries(previousState.previousEnvironment);
  // Restore slots before lowering the count so Git never observes an active
  // count with partially restored entries.
  entries.sort(([left], [right]) => Number(left === "GIT_CONFIG_COUNT") - Number(right === "GIT_CONFIG_COUNT"));
  for (const [name, value] of entries) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  core.info(`git_auth_helpers: extraheader restored`);
}

/**
 * Temporarily override the persisted GitHub extraheader for remote git operations.
 *
 * Adds a command-scope reset and fork token for the callback, then restores the
 * previous Git environment. File-backed credentials remain untouched.
 *
 * @template T
 * @param {string} token
 * @param {() => Promise<T>} callback
 * @param {string} [cwd] - Optional working directory; scopes the git config override to the correct checkout
 * @returns {Promise<T>}
 */
async function withGitHubHostToken(token, callback, cwd) {
  if (!token) {
    return callback();
  }
  const githubServerUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  /** @type {ExtraheaderState | undefined} */
  let previousExtraheaders;
  let overrideApplied = false;
  try {
    previousExtraheaders = await overridePersistedExtraheader(githubServerUrl, token, cwd);
    overrideApplied = true;
    return await callback();
  } finally {
    if (overrideApplied) {
      await restorePersistedExtraheader(githubServerUrl, previousExtraheaders, cwd);
    }
  }
}

module.exports = {
  checkoutHasPersistedExtraheader,
  overridePersistedExtraheader,
  restorePersistedExtraheader,
  withGitHubHostToken,
};
