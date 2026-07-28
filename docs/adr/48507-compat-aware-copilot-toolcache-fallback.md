# ADR-48507: Compat-Aware Copilot Toolcache Fallback for Explicit Version Pins

**Date**: 2026-07-28
**Status**: Draft
**Deciders**: Unknown (automated fix by copilot-swe-agent, triggered by issue #48358)

---

### Context

The `install_copilot_cli.sh` script resolves which Copilot CLI binary to use from two sources: (1) the runner toolcache and (2) a network download. The compat matrix (`compat.json`) defines a compatibility window (`min-agent..max-agent`) that tells the installer which Copilot CLI versions are safe for a given `gh-aw` compiler version. Previously, when a caller passed an explicit version argument, the installer skipped compat matrix lookup entirely and fell through to a network download if the exact version was not cached. This caused unnecessary bandwidth consumption and added a network failure point on every run where the pinned version was absent from the cache, even when a fully compatible cached version was available. Additionally, the `engine.version` field in workflow YAML was silently accepted for the `copilot` engine but never honored — the compiler always installed its own pinned default.

### Decision

We will change `install_copilot_cli.sh` to always resolve the compat window from the matrix when `GH_AW_COMPILED_VERSION` is available, regardless of whether an explicit version argument was passed. When an explicit version is requested but not cached exactly, the installer will fall back to the best available cached version within the compat window instead of downloading immediately. Exact-match behavior is preserved when the requested version is present in the toolcache. We will also add a compile-time warning when `engine.version` is set for the `copilot` engine and update the documentation to reflect that Copilot version pinning is unsupported.

### Alternatives Considered

#### Alternative 1: Keep strict exact-match behavior for explicit version requests

Maintain the previous behavior: if an explicit version is requested and not cached exactly, always download it from the network. This is the simplest control flow and gives the caller maximum determinism.

This was rejected because it wastes bandwidth and creates unnecessary network dependencies. Runners that have a compatible Copilot CLI in the toolcache should not need to make a network request, and the previous behavior made it impossible to benefit from caching when an explicit (often stale) version was pinned.

#### Alternative 2: Always use the compat window and ignore explicit version arguments for Copilot

Resolve entirely from the compat matrix and discard any explicit `VERSION` argument for the Copilot engine, making explicit pinning a no-op.

This was rejected because it removes the ability for callers to force a specific version in scenarios where the compat matrix is unavailable or incorrect. Exact-match behavior is preserved as the first priority; the compat-window fallback only activates when the exact version is absent.

### Consequences

#### Positive
- Eliminates unnecessary network downloads when a compat-window-compatible Copilot CLI is already cached, improving runner performance and reliability.
- Makes the installation resilient to transient CDN failures by preferring a locally cached binary over a remote download.
- Surfacing `engine.version` as unsupported for Copilot (via compile-time warning) prevents user confusion about whether pinning is honored.
- The documentation now accurately reflects which engines support version pinning, reducing mis-configurations.

#### Negative
- The installer now always fetches the compat matrix when `GH_AW_COMPILED_VERSION` is set, even when an explicit version is provided and found in the cache. This adds one conditional network request to paths that previously skipped it entirely.
- The version-resolution control flow in `install_copilot_cli.sh` is more complex, with additional branches for the explicit-version-with-compat-window case.

#### Neutral
- Retry counts for `curl` calls were increased from 3 to 6 with `--retry-all-errors` added; this hardens all download paths but does not change their logical behavior.
- Tests were added for the new explicit-version-with-compat-window toolcache fallback path and for the compiler warning on Copilot version pins.

---

*ADR created by [adr-writer agent]. Review and finalize before changing status from Draft to Accepted.*
