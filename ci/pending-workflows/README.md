# Pending workflows

Workflow files staged here are not active. GitHub only runs workflows under
`.github/workflows/`, and fleet tasks may not add or change those. Sam approves
or drops each staged file.

- `cli-real-journeys.yml`: runs tools/cli-real-journeys on pull requests and
  pushes to alpha. It has three fresh full passes, the helper tests on Ubuntu
  and Windows Python 3.8, and suite tests. Read-only (`contents: read`), no
  secrets. To approve, move it back to `.github/workflows/`.
