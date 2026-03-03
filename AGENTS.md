# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the TypeScript runtime code. Entry points are `src/index.ts` and `src/app.ts`.
- Core engine subsystems live in `src/core/` (`camera/`, `render/`, `scale/`, `gui/`, `io/`).
- Gameplay/domain code is split across `src/game_objects/`, `src/game_world/`, and `src/systems/lod/` (including worker code in `src/systems/lod/workers/`).
- Shader sources are under `src/assets/shaders/`; static assets are served from `public/`.
- `terrain/` is a separate Rust/WASM crate (`terrain_generator`) used for terrain-related logic.

## Build, Test, and Development Commands
- `npm run serve`: start the Rspack dev server for local development.
- `npm run build`: produce a production bundle in `dist/`.
- `npm run test`: run Vitest in watch/interactive mode.
- `npm run coverage`: run tests once and generate text + HTML coverage reports.
- `npm run deploy`: publish `dist/` to GitHub Pages.
- Rust module (optional, in `terrain/`): `cargo build --release`.

## Coding Style & Naming Conventions
- Formatting baseline is defined in `.editorconfig` and `.prettierrc`:
  - UTF-8, LF endings, trim trailing whitespace.
  - 2 spaces by default; 4 spaces for `*.ts`/`*.js`.
  - Prettier: semicolons, single quotes, `printWidth: 80`, no trailing commas.
- TypeScript is `strict` (`tsconfig.json`); prefer explicit types on public APIs.
- File naming follows existing conventions: snake_case for most modules (for example `lod_scheduler.ts`), PascalCase only for type declarations when already established.

## Testing Guidelines
- Framework: Vitest (`vitest.config.ts`) with Node environment and globals enabled.
- Coverage currently includes `src/**/*.{ts,tsx}`.
- Place tests as `*.test.ts` near source files (example: `src/core/scale/scale_manager.test.ts`).
- Add unit tests for bug fixes and for logic-heavy systems (LOD scheduling, chunk evaluation, scale conversions).

## AI Playwright Validation Policy (Mandatory)
- Every AI agent task that modifies repository files must run `npm run pw:validate` before considering the task complete.
- Validation depth is smoke visual and blocking: open app, capture snapshot, capture screenshot.
- If Playwright validation fails, the task is not validated and must not be reported as done.
- Validation should auto-start the local dev server when target URL is unreachable (`PW_AUTO_SERVE=1` default behavior).
- Validation artifacts must be kept under `output/playwright/` and reported in the final task summary.
- Minimum reporting fields in agent final response:
  - command executed (`npm run pw:validate`)
  - validation status (pass/fail)
  - tested URL
  - artifact directory path (`output/playwright/<runId>`)

## Commit & Pull Request Guidelines
- Follow the repository's style: concise, imperative messages, usually Conventional Commit prefixes (`feat:`, `fix:`, `docs:`).
- Keep commits focused by concern (rendering, LOD, tooling, docs).
- PRs should include:
  - A clear summary of behavior changes.
  - Linked issue(s) when applicable.
  - Test evidence (`npm run test` / `npm run coverage`).
  - Screenshots or short clips for visual rendering/UI changes.
