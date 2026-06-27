# Codex Notes For World42

Codex should use these project entry points:
- `AGENTS.md` for operational rules and validation requirements.
- `AI_CONTEXT.md` for shared architecture context.
- `.codex/skills/` for focused local knowledge packs.
- `CLAUDE.md` only as supplemental long-form project context.

Do not treat `.claude/` as authoritative for Codex behavior, but it can be read
when comparing or migrating existing Claude-specific knowledge.

When adding durable guidance that should help both Codex and Claude, update
`AI_CONTEXT.md` first. Keep this file limited to Codex-specific notes.
