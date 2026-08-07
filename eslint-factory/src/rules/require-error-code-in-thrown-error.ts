import { AST_NODE_TYPES, ESLintUtils, TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(name => `https://github.com/github/gh-aw/tree/main/eslint-factory#${name}`);

/** Matches `ERR_*` constant-style identifiers or `E123`-style numeric codes. */
const ERROR_CODE_PATTERN = /\bERR_[A-Z0-9_]+\b|\bE\d{3}\b/;

/**
 * Returns true when the file contains `require("./error_codes.cjs")` (or a
 * relative variant), meaning it has opted into the standardized error-code
 * convention. Files that never import the catalog are skipped entirely so
 * this rule cannot false-positive on code that doesn't use the convention.
 */
function fileUsesErrorCodesCatalog(sourceCode: Readonly<{ ast: TSESTree.Program; getText(): string }>): boolean {
  return /require\(\s*["'][^"']*error_codes\.cjs["']\s*\)/.test(sourceCode.getText());
}

/**
 * Recursively checks whether an expression could statically reference an
 * error code: string/template literals containing an ERR_ or E-number pattern,
 * bare identifiers (assumed to be ERR_* constants, checked by name), or
 * `+`-concatenations where either side references a code.
 */
function expressionReferencesErrorCode(node: TSESTree.Expression): boolean {
  switch (node.type) {
    case AST_NODE_TYPES.Literal:
      return typeof node.value === "string" && ERROR_CODE_PATTERN.test(node.value);
    case AST_NODE_TYPES.TemplateLiteral: {
      const quasisMatch = node.quasis.some(quasi => ERROR_CODE_PATTERN.test(quasi.value.raw));
      const exprMatch = node.expressions.some(expr => expressionReferencesErrorCode(expr as TSESTree.Expression));
      return quasisMatch || exprMatch;
    }
    case AST_NODE_TYPES.Identifier:
      return ERROR_CODE_PATTERN.test(node.name);
    case AST_NODE_TYPES.MemberExpression: {
      const prop = node.property;
      return prop.type === AST_NODE_TYPES.Identifier && ERROR_CODE_PATTERN.test(prop.name);
    }
    case AST_NODE_TYPES.BinaryExpression:
      if (node.operator !== "+") return false;
      return expressionReferencesErrorCode(node.left as TSESTree.Expression) || expressionReferencesErrorCode(node.right);
    default:
      return false;
  }
}

export const requireErrorCodeInThrownErrorRule = createRule({
  name: "require-error-code-in-thrown-error",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "In files that already use the standardized error-code catalog (error_codes.cjs), require thrown Error messages to reference an ERR_* constant or E###-style code so error logs remain filterable/alertable.",
    },
    schema: [],
    messages: {
      missingErrorCode:
        "This file uses error_codes.cjs elsewhere, but this thrown Error message does not reference an ERR_* code (e.g. ERR_VALIDATION, ERR_API). Prefix the message with the appropriate error code for consistent log filtering/alerting.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!fileUsesErrorCodesCatalog(context.sourceCode)) {
      return {};
    }

    return {
      NewExpression(node) {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.Identifier || callee.name !== "Error") return;

        const arg = node.arguments[0];
        if (!arg || arg.type === AST_NODE_TYPES.SpreadElement) return;

        if (expressionReferencesErrorCode(arg)) return;

        context.report({
          node,
          messageId: "missingErrorCode",
        });
      },
    };
  },
});
