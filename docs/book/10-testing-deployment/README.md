---
title: "10. Testing, deployment, and contribution"
description: "Separate test workspaces from live art, understand the static copy boundary, and verify changes reproducibly."
outline: deep
---

# 10. Testing, deployment, and contribution

[Book home](../../README.md) · [Previous: GIF quantization](../09-gif-quantization/README.md) · [Next: character branding](../11-character-branding/README.md)

## TL;DR

Node 22+ runs the development tooling; the shipped app is plain browser
JavaScript with no runtime package dependency.
Build copies `web` into `dist`.
Node tests, isolated browser fixtures, documentation screenshots, and
documentation checks serve different purposes.
The live bridge's default port **4173 is not a test target**.
([package.json:4](../../../package.json#L4-L23),
[scripts/build.mjs:1](../../../scripts/build.mjs#L1-L7),
[playwright.config.js:15](../../../playwright.config.js#L15-L18))

```mermaid
flowchart TD
    accTitle: Evidence before deployment
    accDescr: Pure and bridge tests verify contracts, isolated browsers verify workflows, and a static build is the deployment artifact.
    Change["Source change"] --> Node["Node test suite"]
    Change --> Build["Copy web to dist"]
    Build --> Browser["Isolated browser fixtures"]
    Build --> Screens["Documentation screenshots"]
    Docs["Handbook and source anchors"] --> Check["Documentation checks"]
    Node --> Evidence["Review evidence"]
    Browser --> Evidence
    Screens --> Evidence
    Check --> Evidence
    Build --> Pages["Pages artifact"]
    style Change fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style Node fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Build fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style Browser fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Screens fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style Docs fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style Check fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Evidence fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Pages fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
```

This diagram is a recommended contributor evidence flow, not a claim that
every branch runs every step in CI. The Pages workflow explicitly runs
`npm test` and build; it does not run the browser suite or documentation
commands in the inspected workflow.
([.github/workflows/pages.yml:19](../../../.github/workflows/pages.yml#L19-L34))

## 1. Scripts and dependency boundary

| Command | Configured implementation | Purpose |
|---|---|---|
| `npm start` | `node server.mjs` | Optional local studio and collaboration bridge |
| `npm run build` | `node scripts/build.mjs` | Produce static `dist` content |
| `npm test` | `node --test tests/*.test.mjs` | Top-level Node test modules |
| `npm run test:browser` | `playwright test` | Browser workflows with configured fixtures |
| `npm run agent -- ...` | `node scripts/agent.mjs` | Local handoffs, previews, feedback, and proposals |
| `npm run brand` | `node scripts/build-brand.mjs` | Public branding generation entry point |
| `npm run reference` | `node scripts/create-reference.mjs` | Public reference generation entry point |
| `npm run docs:screenshots` | Build then Playwright with docs config | Reproduce documentation screenshots |
| `npm run docs:check` | `node scripts/check-docs.mjs` | Validate documentation artifacts |

This table documents configured commands, not commands executed by the
handbook writer.
([package.json:7](../../../package.json#L7-L17))

The package is an ES module package (`"type": "module"`), requires Node
`>=22`, and lists Playwright under `devDependencies`.
There is no `dependencies` runtime package list.
Browser modules import repository-local JavaScript, rather than downloading
an editor framework at runtime.
([package.json:5](../../../package.json#L5-L23),
[web/app.js:1](../../../web/app.js#L1-L8))

For a fresh contributor checkout, dependency provisioning is normally
`npm ci`; the workflow uses that command.
Browser binaries must also be available for Playwright before browser work.
Provision tools only in an authorized development environment—do not treat
documentation examples as permission to modify an active artwork machine.
([.github/workflows/pages.yml:20](../../../.github/workflows/pages.yml#L20-L27),
[playwright.config.js:1](../../../playwright.config.js#L1-L18))

## 2. Node tests are not all pure tests

`npm test` discovers all top-level `tests/*.test.mjs`.
The model, review, and GIF modules contain direct assertions over data and
binary output. The bridge test module starts a real child server in an
isolated temporary directory.
([package.json:10](../../../package.json#L10-L10),
[tests/model.test.mjs:1](../../../tests/model.test.mjs#L1-L20),
[tests/bridge.test.mjs:32](../../../tests/bridge.test.mjs#L32-L57))

| Test module | Source-grounded examples |
|---|---|
| `model.test.mjs` | Validation, selection clipping, fill boundaries, source-over blending, independent cels |
| `review.test.mjs` | Feedback identity, reference bytes/type checks, latest exact replacement ID |
| `gif.test.mjs` | Exact colors, deterministic palette, alpha, metadata, scaling, limit failures |
| `bridge.test.mjs` | Real HTTP save/propose/accept, stale revisions, browser boundary checks, feedback durability |

Sources: ([tests/model.test.mjs:11](../../../tests/model.test.mjs#L11-L123),
[tests/review.test.mjs:12](../../../tests/review.test.mjs#L12-L49),
[tests/gif.test.mjs:94](../../../tests/gif.test.mjs#L94-L215),
[tests/bridge.test.mjs:58](../../../tests/bridge.test.mjs#L58-L179)).

The bridge fixture obtains an ephemeral loopback port and uses
`mkdtempSync` under the OS temporary directory.
Cleanup terminates its own child process and removes its own workspace.
It does not use the live `.spritecanvas/workspace.json`.
([tests/bridge.test.mjs:32](../../../tests/bridge.test.mjs#L32-L57))

For a permitted pure-algorithm check that must not start a bridge:

```powershell
node --test tests/model.test.mjs tests/review.test.mjs tests/gif.test.mjs
```

For the full configured Node suite in an authorized test session:

```powershell
npm test
```

Do not describe the first command as coverage of bridge behavior.
The separation matters whenever a task prohibits server tests.

## 3. Browser fixture isolation

Playwright uses one worker, disables full parallelism, and configures:

| Address | Role | Data root |
|---|---|---|
| `127.0.0.1:4173` | Default live bridge | Default `.spritecanvas`; protect existing art |
| `127.0.0.1:4273` | Browser-test bridge | `test-results/bridge-workspace` |
| `127.0.0.1:4274/SpriteCanvas/` | Static Pages-like fixture | `dist`, no bridge API |

Both Playwright web servers set `reuseExistingServer: false`.
An occupied test port should be resolved deliberately, not by falling back to
an existing live session or changing tests to hit port 4173.
([server.mjs:12](../../../server.mjs#L12-L16),
[playwright.config.js:3](../../../playwright.config.js#L3-L18))

```powershell
npm run build
npm run test:browser
```

Build first because the static fixture reads `dist`, while the test bridge
serves `web`. Otherwise local-bridge checks might inspect current code and
static checks inspect an older copy.
([scripts/static-test-server.mjs:6](../../../scripts/static-test-server.mjs#L6-L18),
[server.mjs:15](../../../server.mjs#L15-L15))

The configured viewport is 1440 × 1000, timeout 45 seconds, and expectation
timeout 8 seconds. Traces are retained on failure and screenshots are captured
only on failure for this browser-test config.
Those failure artifacts are distinct from deliberately authored documentation
screenshots.
([playwright.config.js:6](../../../playwright.config.js#L6-L14))

## 4. Build copy allowlist—and its caveat

```mermaid
flowchart LR
    accTitle: Static deployment copy boundary
    accDescr: Only web is copied as a source tree; server, workspace, tests, and dependencies are outside the static input.
    Web["web directory"] --> Copy["cpSync recursive"]
    Copy --> Dist["dist"]
    Dist --> Upload["Pages artifact upload"]
    Private["Private workspace"] -.-> Excluded["Not a copy input"]
    Server["server.mjs and scripts"] -.-> Excluded
    Tests["Tests and dependencies"] -.-> Excluded
    style Web fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style Copy fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style Dist fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Upload fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Private fill:#4a2e2e,stroke:#d45b5b,color:#e0e0e0
    style Server fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style Tests fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style Excluded fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
```

The build creates `dist` if needed and recursively copies `web`.
That is a **directory-level input allowlist**, not a filename sanitizer.
Anything placed in `web` is eligible for publication.
([scripts/build.mjs:5](../../../scripts/build.mjs#L5-L7))

The script does **not** clean existing `dist` first.
It also does not transpile, minify, rewrite URLs, or build the handbook into
a separate site. Existing stray files in a manually modified `dist` can remain.
Keep private data out of both `web` and deployment staging; do not claim the
copy step scrubs an already contaminated directory.
([scripts/build.mjs:1](../../../scripts/build.mjs#L1-L7),
[AGENTS.md:37](../../../AGENTS.md#L37-L40))

## 5. Pages subpaths and the optional API

The HTML references `./app.js` and relative stylesheets.
Browser module imports are relative, and the API helper constructs
`./api/<route>` relative to `document.baseURI`.
These choices preserve the repository subpath instead of assuming hosting
at a domain root.
([web/index.html:9](../../../web/index.html#L9-L13),
[web/lib/storage.js:25](../../../web/lib/storage.js#L25-L29))

The fixture deliberately serves only under `/SpriteCanvas/` and has no bridge
API. Browser initialization probes a bridge only on localhost/127.0.0.1;
when no API is available it can operate in browser-only mode.
Static project/proposal file exchange remains the collaboration path.
([scripts/static-test-server.mjs:6](../../../scripts/static-test-server.mjs#L6-L23),
[web/app.js:1095](../../../web/app.js#L1095-L1120),
[web/app.js:734](../../../web/app.js#L734-L743))

Do not introduce `/assets/...` or `/api/...` browser URLs casually:
those root-relative paths can escape a repository subpath.
The Node CLI's root API URLs are different because it targets the root of
the local bridge, not Pages.
([scripts/agent.mjs:24](../../../scripts/agent.mjs#L24-L24))

## 6. What the Pages workflow actually does

The workflow triggers on pushes to `main` and manual dispatch.
It uses read permission for contents, write for Pages and OIDC tokens, and
a `github-pages` concurrency group with cancellation of in-progress runs.
([.github/workflows/pages.yml:1](../../../.github/workflows/pages.yml#L1-L12))

Its deployment job checks out code, sets up Node 22 with npm caching,
runs `npm ci`, `npm test`, and build, configures Pages, uploads **`dist`**,
then calls the Pages deploy action.
The environment URL comes from the deployment step output.
([.github/workflows/pages.yml:14](../../../.github/workflows/pages.yml#L14-L34))

This is a workflow definition, not proof a deployment completed.
No deployment run, published URL health, or release result was measured for
this chapter.
Keep those operational claims separate from implementation documentation.

## 7. Reproducible documentation commands

From the repository root:

```powershell
npm run build
npm run docs:screenshots
npm run docs:check
```

The screenshot command itself currently includes build before invoking its
dedicated Playwright configuration. The explicit first build makes the
prerequisite visible in a contributor recipe.
Use the documentation fixture, not a manual capture of private live artwork.
([package.json:14](../../../package.json#L14-L15))

Screenshot evidence answers “what did the documented scenario look like?”
It does not prove layer editability, persisted feedback, or stale-revision
rejection. Pair screenshots with source anchors and behavioral assertions.
The model and bridge tests exercise those nonvisual contracts directly.
([tests/model.test.mjs:101](../../../tests/model.test.mjs#L101-L115),
[tests/bridge.test.mjs:80](../../../tests/bridge.test.mjs#L80-L92))

## 8. Contribution recipes

For a **drawing algorithm change**, add a tiny exact-grid test first.
Check selection and bounds, then a browser gesture scenario.
For a **review change**, test both identity races and non-destructive behavior;
ensure static import still uses the shared helper.
([tests/model.test.mjs:43](../../../tests/model.test.mjs#L43-L68),
[tests/review.test.mjs:35](../../../tests/review.test.mjs#L35-L49),
[web/app.js:510](../../../web/app.js#L510-L535))

For an **export change**, distinguish native cells from scaled output and
exercise alpha, frame timing, and resource limits.
For a **deployment change**, inspect what enters `web`/`dist` and test the
subpath fixture without an API.
([tests/gif.test.mjs:141](../../../tests/gif.test.mjs#L141-L215),
[scripts/static-test-server.mjs:6](../../../scripts/static-test-server.mjs#L6-L23))

The repository contract disallows public AI keys, automatic cloud upload,
third-party tracking, and external asset dependencies.
Preserve explicit errors, review snapshots, and revision checks.
([AGENTS.md:36](../../../AGENTS.md#L36-L40))

Use the [source-map evidence matrix](../../appendices/source-map.md) to choose
the smallest relevant tests. Report commands actually run and failures
actually observed; never convert a test file's existence into a passing result.
