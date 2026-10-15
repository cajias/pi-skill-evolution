# Offline local-fix regressions

These tests exercise the real miner, store, and extension lifecycle handlers with synthetic session files and state. Every scenario is a fresh child process with its own HOME, TMPDIR, and CLAUDE_CONFIG_DIR. No Pi process, model, provider, or real session history is used. Network entry points fail closed. A deterministic fake clock tests status cleanup without waiting ten seconds.

Reuse an already available `jiti` and the package's declared `@sinclair/typebox` dependency. Do not install dependencies as part of the tests. If jiti is outside the checkout, set `SKILL_TEST_JITI` to its package directory.

```sh
# Set all three directories to disposable, pre-created locations.
HOME="$TEST_HOME" TMPDIR="$TEST_TMP" CLAUDE_CONFIG_DIR="$TEST_CLAUDE" \
  JITI_FS_CACHE=0 JITI_CACHE=0 SKILL_TEST_JITI="$EXISTING_JITI" \
  node --test test/local-fixes.test.cjs
```

For differential validation, use the same command with `SKILL_TEST_SOURCE` pointing to an unmodified 0.2.0 `src` directory, with its dependencies available. The pristine release should fail the fallback and cancellation tests; the hybrid-index, no-source, and normal timer-expiry controls should still pass.

Coverage: absent/empty/invalid/malformed hybrid index, index precedence, active/archive directories, Unicode project names, ignored filenames and non-directory project entries, no-source behavior, directory-only startup, normal timer expiry, overlapping proposal/degradation statuses, shutdown, repeated startup with and without a new status, and independence between extension instances.

The `before_agent_start` cases cover Pi 1.2.0 user prompts, custom-message runs without a user prompt, unrelated prompts, legacy prompt-only events, and calls before state loads. They verify warning injection preserves the original system prompt and excludes informational issues. Pi 1.2.0 still uses `prompt` on the user event variant: a `"prompt" in event` guard narrows the union without requiring a discriminator on older hosts. These runtime controls also pass on the pre-type-fix source; the regression failure is its typecheck against Pi 1.2.0 declarations, not a runtime field rename.

The port deliberately retains 0.2.0's HOME-relative storage locations, filename matching, and index format. It does not migrate package namespaces, implement an agentDir override, deduplicate directory listings, or change unrelated feedback/session state. The cancellation on repeated startup completes the same status-timer fix: shutdown alone does not cover a session switch.
