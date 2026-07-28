# ADR-48633: Refactor AWF Helpers into Focused Workflow Modules

**Date**: 2026-07-28
**Status**: Draft
**Deciders**: pelikhan (via Copilot SWE agent)

---

### Context

`pkg/workflow/awf_helpers.go` had grown into a large mixed-responsibility file handling AWF command assembly, capability version gates, environment variable exclusion, image digest resolution, and ARC/DinD path rewriting — all in one place. Its companion test file, `awf_helpers_test.go`, mirrored this breadth and had become equally large. Mixed-responsibility files in a hot-path workflow package make it harder to locate specific logic, reason about each concern in isolation, and review changes with confidence. The file had reached a size where contributors regularly needed to scroll through unrelated code to find the function they were looking for.

### Decision

We will split `awf_helpers.go` and `awf_helpers_test.go` into a set of smaller, domain-focused files aligned to the distinct responsibilities the original file had accreted:

- `awf_command.go` — top-level AWF command assembly (`BuildAWFCommand`)
- `awf_command_builder.go` — AWF args, command prefix, and shell wrapping (`BuildAWFArgs`, `GetAWFCommandPrefix`)
- `awf_capabilities.go` — AWF version/capability gates (`awfVersionAtLeast`, `awfSupports*`)
- `awf_env.go` — env exclusion and max-AI-credits injection
- `awf_digest.go` — image digest lookup and tag augmentation
- `awf_arc_dind.go` — ARC/DinD path rewriting and chroot patch helpers
- `awf_helpers.go` — retained for shared constants/config and workflow-call `network_allowed` handling

Tests are split along the same boundaries. Public entry points and all existing behavior are preserved; the change is organizational rather than semantic.

### Alternatives Considered

#### Alternative 1: Keep the Monolith with Internal Sections

Add doc comments and blank-line section headers inside `awf_helpers.go` to visually group responsibilities without splitting files. This is zero-cost to merge and preserves the single-file lookup mental model. However, it does not reduce file size, does not help IDE navigation or `grep`-based search, and does not enforce the separation of concerns at the Go compiler level — any function can still reach any other without an explicit import.

#### Alternative 2: Partial Extraction (ARC/DinD Only)

Extract only the ARC/DinD path-rewriting code into `awf_arc_dind.go` and leave the rest in `awf_helpers.go`. This addresses the noisiest reviewer complaint (ARC/DinD logic buried in a generic helpers file) with a minimal-footprint change. The downside is that `awf_helpers.go` remains large and mixed, capability gates and command-building logic remain co-located, and a follow-up split would be needed anyway as the file continues to grow.

### Consequences

#### Positive
- Each file now has a single, clearly named responsibility — developers can navigate directly to `awf_capabilities.go` for version gates or `awf_env.go` for env exclusion without reading unrelated code.
- Tests are co-located with the code they exercise, making it easier to understand test scope and add new cases without navigating between large files.
- Smaller per-file diffs in future PRs that touch a single concern (e.g., adding a new capability gate) will be easier to review.
- The Go compiler enforces file-level grouping: constants and unexported helpers in one file cannot accidentally bleed into unrelated logic in another without a clear architectural reason.

#### Negative
- The `pkg/workflow` package now has more files; contributors new to the codebase must learn the file-to-responsibility mapping to know where to look for a given function.
- Any refactoring that touches a cross-cutting concern (e.g., changing how `FirewallConfig` is threaded through capability checks) will now require edits across multiple files instead of one.
- The split introduces no new abstraction boundaries (all files remain in the same package), so the file boundaries are enforced only by convention, not by Go's package visibility rules.

#### Neutral
- The public API surface (`BuildAWFCommand`, `BuildAWFArgs`, `GetAWFCommandPrefix`, etc.) is unchanged; callers outside `pkg/workflow` require no updates.
- The `awf_helpers.go` file is retained as a home for shared constants and configuration — it is now smaller but still exists, which may cause confusion about what belongs there versus in the new files.
- Test build tags (`//go:build !integration`) and package declarations are preserved verbatim across all new test files.

---

*ADR created by [adr-writer agent]. Review and finalize before changing status from Draft to Accepted.*
