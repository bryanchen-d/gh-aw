import { RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
import { requireErrorCodeInThrownErrorRule } from "./require-error-code-in-thrown-error";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "commonjs",
  },
});

describe("require-error-code-in-thrown-error", () => {
  it("uses the correct docs URL", () => {
    expect(requireErrorCodeInThrownErrorRule.meta.docs?.url).toBe(
      "https://github.com/github/gh-aw/tree/main/eslint-factory#require-error-code-in-thrown-error"
    );
  });

  it("validates throw sites against the error-code convention", () => {
    ruleTester.run("require-error-code-in-thrown-error", requireErrorCodeInThrownErrorRule, {
      valid: [
        // File doesn't use error_codes.cjs at all — rule stays silent regardless of throw shape.
        `throw new Error("Something went wrong");`,
        // Error code referenced via template literal expression.
        `
          const { ERR_VALIDATION } = require("./error_codes.cjs");
          throw new Error(\`\${ERR_VALIDATION}: Missing required field: title\`);
        `,
        // Error code referenced as a literal string prefix.
        `
          require("./error_codes.cjs");
          throw new Error("ERR_API: request failed");
        `,
        // Error code referenced via identifier concatenation.
        `
          const { ERR_PARSE } = require("./error_codes.cjs");
          throw new Error(ERR_PARSE + ": invalid JSON");
        `,
        // Numeric E### style code.
        `
          require("./error_codes.cjs");
          throw new Error("E404: not found");
        `,
        // No arguments to Error() — nothing to check.
        `
          require("./error_codes.cjs");
          throw new Error();
        `,
      ],
      invalid: [
        {
          code: `
            const { ERR_VALIDATION } = require("./error_codes.cjs");
            throw new Error("Missing required field: title");
          `,
          errors: [{ messageId: "missingErrorCode" }],
        },
        {
          code: `
            require("./error_codes.cjs");
            function resolveNode(itemNumber) {
              throw new Error(\`Failed to resolve GraphQL node ID for issue #\${itemNumber}\`);
            }
          `,
          errors: [{ messageId: "missingErrorCode" }],
        },
        {
          code: `
            require("./error_codes.cjs");
            throw new Error("bad" + " input");
          `,
          errors: [{ messageId: "missingErrorCode" }],
        },
      ],
    });
  });
});
