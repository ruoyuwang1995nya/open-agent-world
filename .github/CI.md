# Pull request checks

Workflow aggregate contexts are `CI required`, `Docs required`, and `Native required`.
They run without path filters on PRs to and pushes to `dev`/`main`, and on manual
dispatch. Each aggregate fails unless every dependency succeeds, including all
matrix targets. Whether they are required for a particular PR is controlled by live GitHub
rulesets. See [repository settings](../docs/contributing/index.md#repository-administrator-setup);
repository code cannot establish their current enforcement.

Frontend unit tests run in parallel with the production build and core browser
acceptance. Both use the existing preparation step to install each Pack's declared
dependencies in its own directory; unit tests need no Python environment or
browser installation. The build job packs the public SDK, builds the existing
Greeter outside the checkout, installs
its `.oawpack`, restarts the production host, and checks cards and frontend assets
in Chromium with the mock runtime. The fixture uses `oaw.pack.toml` and the
canonical Schema 3 `build-project` toolchain. CI checks host loading and saved
card behavior; this fixture has no Sandbox dependency. No Marketplace or
model credentials are used.

`Application version consistency` checks all committed application declarations.
Desktop release requires successful latest runs of all three validation workflows
on the exact source SHA, then pins every builder to that SHA. Manual preview
builds have the same gate. See [releasing](../docs/releasing.md).

`ci.yml` runs on PRs targeting `dev` or `main`, pushes to those branches, and
manual dispatch. The three aggregate check names remain stable; there are no
path filters or `continue-on-error` bypasses. Routine checks target completion
within ten minutes. Job timeouts are failure limits, not a guarantee of successful
completion within that time: runner queues, cold caches and downloads can vary.

- `Backend tests (1/6)` through `(6/6)`: all tests in `tests`, `backend/tests`,
  `packs/codex/tests`, and the AtomSculptor Report agent suite,
  including public SDK contracts, migrations, recovery, authorization, and run
  lifecycle tests. Pytest collects the complete suite on each runner, then assigns
  sorted test files round-robin. Every file runs once, with its fixtures and test
  order intact. Separate runners isolate plugin preparation and subprocesses.
  `CI required` waits for all six shards; a failure does not cancel the others.
  The Core-only installation smoke runs once, on shard 1.
- `Frontend unit tests`: the complete Vitest suite with prepared SDK and Pack
  dependencies, running independently of the production build.
- `Frontend tests and build`: TypeScript, Vite production build, SDK dependency
  boundaries, executable and declarative Pack install/restart, deployment, and
  hosted login/user isolation in Chromium against that build.
- `Core smoke (Windows)`: source setup, real HTTP startup, persistent restart,
  filesystem recovery, migration, storage and native acceptance helpers.
  OS-independent authentication, request, idempotency and deployment suites run
  in Linux rather than being repeated here.

Shared UI acceptance in Chromium/WebKit and the complex research workspace
publication scenario are opt-in: run this workflow manually with
`full_acceptance: true`. These suites also remain available locally. Visual
polish and complete scientific workflows require human review; exact RGB,
blur and shadow values are not CI requirements. Core browser integration and
all frontend/backend unit tests still run on every PR and push.

Python 3.12 and Node 24 match the desktop release toolchain. `uv sync --locked`
and `npm ci` reject manifest/lock drift. The full backend job retains the
existing installation of all repository plugin packages, which own their
extra dependencies, and installs both optional provider adapters. It needs
no external model credentials. `run-backend-tests.py` makes plugin sources
available during collection, including when using an existing local Python
environment instead of editable plugin installations.

Run the full backend suite from the repository root after installing the
locked backend environment and the repository plugins:

```sh
backend/.venv/bin/python .github/run-backend-tests.py tests backend/tests packs/codex/tests plugins/atomsculptor/tests/test_log_review_agent.py
```

To reproduce a CI shard, append `--shard 1/6` (through `6/6`). Omitting
the option runs the complete suite. Each shard uploads its own JUnit report and
prints its 20 slowest tests. Sharding reduces elapsed time, not test coverage;
total runner minutes can increase slightly because collection and setup repeat.

On Windows use `backend/.venv/Scripts/python.exe`. The frontend commands are
`npm --prefix frontend test` and `npm --prefix frontend run build`.
Run `npm --prefix frontend run build:pack-sdk` and
`npm --prefix frontend run prepare:packs` before unit tests in a fresh checkout.
Browser acceptance needs a production build and Playwright's Chromium;
`npm --prefix frontend run test:e2e:ui` also needs WebKit.
The deployment configuration starts its own isolated mock runtime
and uses `frontend/dist`; `OAW_TEST_PYTHON` can select an existing interpreter.
UI acceptance starts a separate preview profile with Sandbox execution disabled.
WebKit checks do not replace verification of the installed macOS WKWebView.

Backend JUnit reports and failed browser traces/screenshots are retained for
seven days. Existing platform, native isolation and external science tests
retain their documented prerequisite skips. These checks do not establish
native Sandbox acceptance, real model/network acceptance or multi-user
enterprise readiness. The workflow does not configure branch protection;
repository administrators can require its checks in the branch ruleset.

Native checks retain Windows, Apple Silicon and Intel macOS targets. Cargo
dependencies are cached per toolchain/target and Rust formatting runs once.
Installer packaging and release provenance checks remain in the release workflow;
the ten-minute target applies to routine validation, not installer production.

## Documentation

`docs.yml` checks PRs to and pushes to `dev`/`main` without path filters:
removing a source file can break a documentation link even in a code-only PR.
Its `build` job installs only `scripts/docs-requirements.txt` and runs
`python scripts/docs.py check`. This validates source inventory, heading/language
rules, repository links, the strict MkDocs build, and generated links/search.

The separate `Documentation tutorial examples` job uses locked backend test
dependencies and installs the Hello World and Greeter entry points. Pages deploys
only after both jobs pass on `dev`, outside pull requests. Build success and
deployment success remain separate results.

Local setup and the identical validation command are in the
[documentation maintenance guide](../docs/developers/documentation.md).
