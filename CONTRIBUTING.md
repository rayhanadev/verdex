# Contributing to verdex

Thanks for your interest in contributing to verdex! This document covers the process for contributing to this project.

## Getting started

1. Fork and clone the repository:

   ```sh
   git clone https://github.com/<your-username>/verdex.git
   cd verdex
   ```

2. Install dependencies:

   ```sh
   bun install
   ```

3. Verify everything works:

   ```sh
   bun run typecheck
   bun run lint
   bun run test
   ```

## Development workflow

verdex is a single published package, `@rayhanadev/verdex`. It has zero runtime dependencies and is developed Bun-first.

### Useful commands

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `bun run test`       | Run the test suite once (`vitest run`)   |
| `bun run test:watch` | Run tests in watch mode (`vitest`)       |
| `bun run coverage`   | Run tests with coverage                  |
| `bun run typecheck`  | Type-check with `tsgo --noEmit`          |
| `bun run lint`       | Lint with oxlint                         |
| `bun run format`     | Format with oxfmt                        |
| `bun run knip`       | Detect dead code and unused dependencies |
| `bun run build`      | Build with tsdown (smoke test)           |
| `bun run changeset`  | Add a changeset for a user-facing change |

### Code style

- Code is formatted with [oxfmt](https://oxc.rs) and linted with [oxlint](https://oxc.rs).
- TypeScript strict mode is enabled. Type-checking uses [`tsgo`](https://github.com/microsoft/typescript-go) (the `@typescript/native-preview` compiler) via `bun run typecheck`.
- Dead code and unused dependencies are detected with [knip](https://knip.dev).
- All of these checks run in CI — make sure they pass before opening a PR.

### Writing tests

Tests use [Vitest](https://vitest.dev) and live in `tests/`. They are **not** co-located with the source, because verdex ships its TypeScript source (`src/`) directly and we don't want test files in the published package.

```sh
bun run test        # run once
bun run test:watch  # watch mode
bun run coverage    # with coverage
```

### Ship-source model

verdex publishes its TypeScript source rather than compiled output. The package's `files` field is `["src", "README.md", "LICENSE"]` and its `exports` point at `./src/index.ts`. The `dist/` directory produced by `bun run build` is gitignored and not published — `build` exists purely as a tsdown smoke test to confirm the package still bundles cleanly.

Keep this in mind when contributing: anything added under `src/` ships to users, so avoid putting fixtures, scratch files, or test helpers there.

## Making changes

1. Create a branch from `main`:

   ```sh
   git checkout -b my-change
   ```

2. Make your changes and add tests in `tests/` for any new behavior.

3. Run the full check suite:

   ```sh
   bun run typecheck && bun run lint && bun run knip && bun run test && bun run build
   ```

4. Commit your changes with a clear message describing the **why**, not just the what.

5. Push and open a pull request against `main`.

## Changesets

If your change is user-facing (anything that affects the published `@rayhanadev/verdex` package), add a changeset:

```sh
bun run changeset
```

Follow the prompts to describe your change. The changeset will be committed alongside your code and drives the next version bump and changelog entry.

## Pull requests

- Keep PRs focused — one logical change per PR.
- Fill in the PR template.
- CI must be green: typecheck, lint, knip, tests, and build all have to pass.
- A maintainer will review your PR. Be open to feedback and iterate.

## Reporting bugs

Use the [bug report template](https://github.com/rayhanadev/verdex/issues/new?template=bug-report.md) on GitHub Issues. Include a minimal reproduction if possible.

Since verdex is an authorization and policy engine, security matters: if you find a vulnerability (for example a way to bypass policy evaluation or pollute prototypes), please follow the process in [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Suggesting features

Use the [feature request template](https://github.com/rayhanadev/verdex/issues/new?template=feature-request.md) on GitHub Issues. Describe the use case and why the existing primitives don't cover it.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
