#!/usr/bin/env python3
"""Check DCO trailers on contribution commits, without executing their contents."""

import subprocess
import sys


# Dependabot's native sign-off uses its service contact, while its commit
# author uses GitHub's noreply address. This is an identity alias, not a bot
# exemption: the native sign-off must still be present. DCO is a declaration,
# not cryptographic identity verification.
DEPENDABOT_AUTHOR = (
    "dependabot[bot]",
    "49699333+dependabot[bot]@users.noreply.github.com",
)
DEPENDABOT_SIGNOFF = "dependabot[bot] <support@github.com>"


def git(*args, input_text=None):
    return subprocess.run(
        ["git", *args], input=input_text, text=True, encoding="utf-8",
        errors="strict", capture_output=True, check=True,
    ).stdout


def queue_merges(base, head):
    # The event's trusted base/head delimit the queue's first-parent merge
    # chain. Only those synthetic merges are exempt; contributor merges on
    # the PR side of that chain still need their author's sign-off.
    merges = set()
    cursor = head
    for commit in git("rev-list", "--first-parent", f"{base}..{head}").splitlines():
        parents = git("show", "-s", "--format=%P", commit).split()
        if commit != cursor or len(parents) < 2:
            raise ValueError("the queue range must be a first-parent merge chain")
        merges.add(commit)
        cursor = parents[0]
    if not merges or cursor != base:
        raise ValueError("the queue merge chain must end at the event base")
    return merges


def check(base, head, merge_group=False):
    if git("rev-parse", "--is-shallow-repository").strip() != "false":
        raise ValueError("a complete, non-shallow repository is required")
    # Resolve first so option-like input cannot become a git-log option.
    base = git("rev-parse", "--verify", "--end-of-options", base + "^{commit}").strip()
    head = git("rev-parse", "--verify", "--end-of-options", head + "^{commit}").strip()
    git("merge-base", base, head)
    commits = git("rev-list", "--reverse", f"{base}..{head}").splitlines()
    if merge_group:
        synthetic = queue_merges(base, head)
        commits = [commit for commit in commits if commit not in synthetic]
    if not commits:
        raise ValueError("the contribution range contains no commits")

    failures = []
    for commit in commits:
        name, email, message = git("show", "-s", "--format=%an%x00%ae%x00%B", commit).split("\0", 2)
        expected = {f"{name} <{email}>"}
        if (name, email) == DEPENDABOT_AUTHOR:
            expected.add(DEPENDABOT_SIGNOFF)
        trailers = git("interpret-trailers", "--parse", "--no-divider", input_text=message)
        signoffs = {
            value.strip()
            for line in trailers.splitlines()
            for key, separator, value in [line.partition(":")]
            if separator and key.casefold() == "signed-off-by"
        }
        if not expected.intersection(signoffs):
            failures.append(commit)

    if failures:
        for commit in failures:
            print(f"DCO: {commit[:12]} lacks its author's Signed-off-by trailer.", file=sys.stderr)
        print("Read DCO and the contribution guide before adding a sign-off.", file=sys.stderr)
        return 1
    print(f"DCO: all {len(commits)} contribution commits carry a matching sign-off.")
    return 0


def main():
    merge_group = len(sys.argv) == 4 and sys.argv[3] == "--merge-group"
    if len(sys.argv) != 3 and not merge_group:
        print("usage: check-dco.py <base-commit> <head-commit> [--merge-group]", file=sys.stderr)
        return 2
    try:
        return check(*sys.argv[1:3], merge_group=merge_group)
    except (subprocess.CalledProcessError, UnicodeError, ValueError) as error:
        # Fail closed on missing/shallow history or malformed input. Do not
        # dump commit messages or arbitrary git diagnostics into CI logs.
        print(f"DCO: could not validate the complete range ({type(error).__name__}).", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
