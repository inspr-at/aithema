# CI runner sharing

Aithema shares the organization's hosted runner slots with other projects.
Each PR runs at most two of its four browser shards at once. Merge queue
(`merge_group`) and main-branch push runs allow all four shards at once.
This is a per-run limit; the coordinator's builder cap of four controls
cross-PR demand. GitHub concurrency cannot express a cross-PR limit above one.

The CI concurrency group is `ci-${{ github.event.pull_request.number || github.ref }}`.
A newer run for the same PR cancels the older run. `cancel-in-progress` is
true only for `pull_request`; merge queue and main push runs never request
in-progress cancellation. Queue runs use their group-specific
`refs/heads/gh-readonly-queue/...` ref, separate from PR numbers and main.
GitHub can still replace pending runs in a shared concurrency group; main
runs therefore serialize, and the guarantee concerns in-progress runs.

## Docs-only PRs

The `changes` job compares the PR's base/head with a three-dot Git diff.
A nonempty change containing only `docs/**` or `**/*.md` (including root
Markdown files) takes the light path. Files under any `test/` or `tests/`
directory always require full CI, including Markdown fixtures. Mixed changes,
workflow changes, and moving source files into docs require full CI too.
Detection errors fail the changes job rather than silently approving a PR.

On the light path, `test` and each `browser (1/4)` through `browser (4/4)`
job run an explicit success step. They skip dependency installation, packaging,
unit tests and browsers. Their check names stay unchanged; no workflow-level
path filter leaves required checks pending. The separate `dco` and `dco-tests`
jobs still run normally, so docs contributions also need commit signoffs.
Merge queue and main push runs always take the full path, even for docs.
Repository rulesets and required-check settings are unchanged.

## Retry failed jobs

After a transient failure, use **Re-run failed jobs** in the GitHub Actions run.
This preserves successful job results and avoids spending shared slots on them
again. Push a new commit when the source needs fixing; PR dedupe cancels the
superseded CI run. A docs-only follow-up PR can verify the light path by checking
that all five CI check jobs report success without installation or browser steps.

## Validation and references

`test/ci-slot-sharing.test.js` parses the workflow and checks concurrency,
parallelism, stable check jobs, and step guards. It also executes the actual
detector against temporary Git histories, including test fixtures, mixed changes,
renames, unusual filenames, errors, and docs-only merge queue/main events.
The existing merge-queue tests check all seven required check names.
Run tests on the designated remote test machine or in PR CI.

The expression in `strategy.max-parallel` uses the `github` context, which is
[allowed in job strategy](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability).
GitHub documents [max-parallel](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymax-parallel),
[conditional cancellation and pending-run replacement](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency),
and [merge queue temporary branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).
Validate workflow syntax and expression types with pinned `actionlint` v1.7.7;
no repository dependency or installation is needed.
