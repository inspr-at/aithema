# Next release — unreleased

- START-549 / AIT-306: hosts can pass the shared OpenRouter `spendCap` to `createOpenAIImages`; image generation and edits now count toward the same cap as reasoning and refuse before dispatch when it is exhausted.

- AIT-308: hosts can pass `spendCap` to direct OpenAI image generation and edits too. Calls reserve `binding.maxMicro` before fetching; direct responses charge the host's admitted per-call `imageCost` against usage tokens, or the admitted ceiling when that price is unavailable. Common `binding.rates`, including zero placeholders, never price capped images. Unknown dispatched outcomes retain uncertain holds; calls without `spendCap` keep their existing behavior.
