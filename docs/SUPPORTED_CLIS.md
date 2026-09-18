# Supported CLIs

Upstream career-ops is AI-agnostic and runs on several command-line agent
tools. **This fork runs on Claude Code only.** The entry wrappers, skill
entrypoints and context files for the other CLIs were removed, along with the
market language modes and the legacy Gemini API evaluator, because nothing here
drives them and an entry file that names a CLI nobody uses is a promise the
repository cannot keep.

| CLI | Entry File | How to Invoke |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` | Interactive: `claude` (then `/career-ops`). Headless/Batch: `claude -p "prompt"` |

The core logic is shared via `AGENTS.md` and is not Claude-specific: adding a
CLI back means restoring its entry wrapper, adding one row to
`SKILL_ENTRYPOINTS` in `scaffolder/bin/skill-entrypoints.mjs`, and listing its
paths in `SYSTEM_PATHS` in `update-system.mjs`. Upstream still ships all of
them, so `git merge upstream/main` will offer the deleted files back.
