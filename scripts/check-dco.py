#!/usr/bin/env python3
"""Check DCO trailers on contribution commits, without executing their contents."""

import math
import os
import selectors
import subprocess
import sys
import tempfile
import time


# Dependabot's native sign-off uses its service contact, while its commit
# author uses GitHub's noreply address. This is an identity alias, not a bot
# exemption: the native sign-off must still be present. DCO is a declaration,
# not cryptographic identity verification.
DEPENDABOT_AUTHOR = (
    "dependabot[bot]",
    "49699333+dependabot[bot]@users.noreply.github.com",
)
DEPENDABOT_SIGNOFF = "dependabot[bot] <support@github.com>"


# Match the shared JavaScript reader's 64 MiB / five-minute defaults. This
# checker remains Python-only so isolated DCO checks need no Node runtime.
EXEC_MAX_BUFFER = 64 * 1024 * 1024
EXEC_TIMEOUT_MS = 5 * 60 * 1000


class DcoExecBoundError(ValueError):
    pass


def git(*args, input_text=None, max_buffer=EXEC_MAX_BUFFER, timeout=EXEC_TIMEOUT_MS):
    for name, value in [("maxBuffer", max_buffer), ("timeout", timeout)]:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"Invalid exec bound {name}: expected a positive finite number")

    def exceeded(bound):
        return DcoExecBoundError(
            f'Release command "git {" ".join(args)}" exceeded {bound}; '
            'review the required bound and raise it explicitly in scripts/check-dco.py.')

    # File-backed stdin avoids blocking on a large commit message while draining
    # both output pipes. Read at most one chunk beyond the cap, then kill/reap.
    with tempfile.TemporaryFile() as source:
        if input_text is not None:
            source.write(input_text.encode("utf-8"))
        source.seek(0)
        deadline = time.monotonic() + timeout / 1000
        with subprocess.Popen(["git", *args], stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
            stdout, stderr = bytearray(), bytearray()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ, stdout)
                    selector.register(child.stderr, selectors.EVENT_READ, stderr)
                    while selector.get_map():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise exceeded(f"timeout={timeout} ms")
                        ready = selector.select(remaining)
                        if not ready:
                            raise exceeded(f"timeout={timeout} ms")
                        for key, _ in ready:
                            chunk = os.read(key.fd, 64 * 1024)
                            if not chunk:
                                selector.unregister(key.fileobj)
                                continue
                            key.data.extend(chunk)
                            if len(stdout) + len(stderr) > max_buffer:
                                raise exceeded(f"maxBuffer={max_buffer} bytes")
                try:
                    status = child.wait(timeout=max(0, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    raise exceeded(f"timeout={timeout} ms") from None
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait()
            output = stdout.decode("utf-8", errors="strict")
            if status:
                raise subprocess.CalledProcessError(status, ["git", *args], output, stderr.decode("utf-8", errors="strict"))
            return output


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
    except DcoExecBoundError as error:
        print(f"DCO: {error}", file=sys.stderr)
        return 2
    except (subprocess.CalledProcessError, UnicodeError, ValueError) as error:
        # Fail closed on missing/shallow history or malformed input. Do not
        # dump commit messages or arbitrary git diagnostics into CI logs.
        print(f"DCO: could not validate the complete range ({type(error).__name__}).", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
