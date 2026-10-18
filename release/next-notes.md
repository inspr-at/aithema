# Next release — unreleased

- **For hosts:** consent documents now include `consentRevision`; send it as `processing.revision` for grants and withdrawals. Stale decisions return 409 `consent-stale` without consent side effects. The grant port receives `decision.revision`; enforce it in shared ledgers too. Omitting the revision remains compatible but is deprecated and offers no stale-tab protection. Settings reloads a refused choice for visitor review and confirms successful choices by revision and items, allowing versioned contracts (AIT-321).
