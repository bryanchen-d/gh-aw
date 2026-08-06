import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { requireCloseSyncAfterOpenSyncRule } from "./require-closesync-after-opensync";

const cjsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "commonjs",
  },
});

const esmRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("require-closesync-after-opensync", () => {
  it("valid: fd closed via try/finally (CommonJS)", () => {
    cjsRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [
        `const fs = require("fs");
         function f() {
           const fd = fs.openSync(path, "r");
           try {
             fs.readSync(fd, buf, 0, len, 0);
           } finally {
             fs.closeSync(fd);
           }
         }`,
        `const fs = require("fs");
         function f() {
           const fd = fs.openSync(path, "w");
           fs.writeSync(fd, data);
           fs.closeSync(fd);
         }`,
      ],
      invalid: [],
    });
  });

  it("valid: destructured openSync/closeSync from fs", () => {
    cjsRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [
        `const { openSync, closeSync } = require("fs");
         function f() {
           const fd = openSync(path, "r");
           try {
             doWork(fd);
           } finally {
             closeSync(fd);
           }
         }`,
      ],
      invalid: [],
    });
  });

  it("valid: non-fs receiver names with openSync are ignored", () => {
    cjsRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [`function f() { const fd = mockFs.openSync(path, "r"); }`, `function f() { const fd = storage.openSync(path); }`],
      invalid: [],
    });
  });

  it("invalid: fd from fs.openSync() is never closed (CommonJS)", () => {
    cjsRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [],
      invalid: [
        {
          code: `const fs = require("fs");
                 function f() {
                   const outputFd = fs.openSync(outputPath, "w", 0o600);
                   spawn(cmd, args, { stdio: ["pipe", outputFd, "ignore"] });
                 }`,
          errors: [{ messageId: "requireClose" }],
        },
      ],
    });
  });

  it("invalid: fd read but closeSync never called on it", () => {
    cjsRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [],
      invalid: [
        {
          code: `const fs = require("fs");
                 function f() {
                   const fd = fs.openSync(path, "r");
                   fs.readSync(fd, buf, 0, len, 0);
                 }`,
          errors: [{ messageId: "requireClose" }],
        },
      ],
    });
  });

  it("invalid: destructured openSync fd never closed", () => {
    cjsRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [],
      invalid: [
        {
          code: `const { openSync } = require("fs");
                 function f() {
                   const fd = openSync(path, "r");
                   doWork(fd);
                 }`,
          errors: [{ messageId: "requireClose" }],
        },
      ],
    });
  });

  it("valid: ESM import with fd closed", () => {
    esmRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [
        `import fs from "fs";
         function f() {
           const fd = fs.openSync(path, "r");
           try {
             fs.readSync(fd, buf, 0, len, 0);
           } finally {
             fs.closeSync(fd);
           }
         }`,
      ],
      invalid: [],
    });
  });

  it("invalid: ESM import with fd never closed", () => {
    esmRuleTester.run("require-closesync-after-opensync", requireCloseSyncAfterOpenSyncRule, {
      valid: [],
      invalid: [
        {
          code: `import fs from "fs";
                 function f() {
                   const fd = fs.openSync(path, "r");
                   fs.readSync(fd, buf, 0, len, 0);
                 }`,
          errors: [{ messageId: "requireClose" }],
        },
      ],
    });
  });
});
