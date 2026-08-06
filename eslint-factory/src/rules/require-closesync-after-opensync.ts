import { AST_NODE_TYPES, ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { createFsSyncMethodResolver } from "./try-catch-rule-utils";

const createRule = ESLintUtils.RuleCreator(name => `https://github.com/github/gh-aw/tree/main/eslint-factory#${name}`);

const OPEN_SYNC_METHODS = new Set(["openSync"]);
const CLOSE_SYNC_METHODS = new Set(["closeSync"]);

export const requireCloseSyncAfterOpenSyncRule = createRule({
  name: "require-closesync-after-opensync",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every file descriptor obtained from fs.openSync() to be passed to fs.closeSync() " +
        "somewhere in the same function. openSync() acquires a raw OS file descriptor that is never " +
        "automatically released by the garbage collector; forgetting to close it leaks a file handle " +
        "for the lifetime of the process, which can exhaust the descriptor limit in long-running or " +
        "repeatedly-invoked actions. Scope: this rule only tracks simple `const fd = fs.openSync(...)` " +
        "bindings and looks for any fs.closeSync(fd) reference to that same variable within the enclosing " +
        "function; it does not attempt to prove that the close call executes on every code path.",
    },
    schema: [],
    messages: {
      requireClose:
        "File descriptor '{{name}}' from fs.openSync() is never passed to fs.closeSync() — this leaks an OS file handle. " +
        "Close it explicitly (ideally in a try/finally) once you are done reading or writing.",
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    const resolveOpenSync = createFsSyncMethodResolver(sourceCode, OPEN_SYNC_METHODS, { allowUnboundFsIdentifier: true });
    const resolveCloseSync = createFsSyncMethodResolver(sourceCode, CLOSE_SYNC_METHODS, { allowUnboundFsIdentifier: true });

    function isPassedToCloseSync(identifier: TSESTree.Identifier): boolean {
      const parent = identifier.parent;
      if (!parent || parent.type !== AST_NODE_TYPES.CallExpression) return false;
      if (parent.arguments[0] !== identifier) return false;
      return resolveCloseSync(parent) === "closeSync";
    }

    return {
      VariableDeclarator(node: TSESTree.VariableDeclarator) {
        if (!node.init || node.init.type !== AST_NODE_TYPES.CallExpression) return;
        if (resolveOpenSync(node.init) !== "openSync") return;
        // Only simple identifier bindings are tracked; destructuring an fd out of a
        // pattern is not a realistic pattern for openSync() and is out of scope.
        if (node.id.type !== AST_NODE_TYPES.Identifier) return;

        const idName = node.id.name;
        let scope = sourceCode.getScope(node);
        let variable = scope.set.get(idName);
        while (!variable && scope.upper) {
          scope = scope.upper;
          variable = scope.set.get(idName);
        }
        if (!variable) return;

        const hasClose = variable.references.some(ref => ref.identifier.type === AST_NODE_TYPES.Identifier && isPassedToCloseSync(ref.identifier));

        if (!hasClose) {
          context.report({ node: node.init, messageId: "requireClose", data: { name: idName } });
        }
      },
    };
  },
});
