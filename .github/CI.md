# Pull request checks

`ci.yml` extends the existing workflow on PRs targeting `dev` or `main`, pushes
to those branches, and manual dispatch. Check names already used by branch
rules remain stable; there are no path filters, blanket skips, or
`continue-on-error` bypasses.

- `Backend tests`: all tests in `tests` and `backend/tests`, including public
  SDK contracts, migrations, recovery, authorization, and run lifecycle tests.
- `Frontend tests and build`: Vitest, TypeScript, Vite production build, and
  the deployment Playwright scenario against that build.
- `Core smoke (Windows)`: startup, authentication, deployment, request
  context/correlation/health, idempotency, persistence, migration and storage.

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
backend/.venv/bin/python .github/run-backend-tests.py tests backend/tests
```

On Windows use `backend/.venv/Scripts/python.exe`. The frontend commands are
`npm --prefix frontend test`, `npm --prefix frontend run build`, and
`npm --prefix frontend run test:e2e:deployment` after installing Playwright's
browser. The deployment configuration starts its own isolated mock runtime
and uses `frontend/dist`; `OAW_TEST_PYTHON` can select an existing interpreter.

Backend JUnit reports and failed browser traces/screenshots are retained for
seven days. Existing platform, native isolation and external science tests
retain their documented prerequisite skips. These checks do not establish
native Sandbox acceptance, real model/network acceptance or multi-user
enterprise readiness. The workflow does not configure branch protection;
repository administrators can require its checks in the branch ruleset.
