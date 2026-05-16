---
name: research
description: Use whenever ANY dependency appears in the task or your context window, including but not limited to SDKs, packages, CLIs, APIs, frameworks, runtimes, configs, tools, docs, examples, implementation details, etc. If it could have changed since your knowledge cutoff ~6 months ago, don't be lazy and research the current definition of correct.
---

For every dependency you touch, proactively consider whether it COULD have changed since your knowledge cutoff MONTHS ago.

If yes, even slightly:

1. Ensure it is git cloned into `../sources` (relative to the repo root) and uses the exact version that you need for the task. To update all versions to latest, run: `../sync.sh`.
   > If `../sources` is missing, clone `https://github.com/sloikodavid/sources`.
2. Query the cloned dependency source code through a subagent, or analyze it yourself when you need a more expensive but raw understanding.

If source code is unavailable, IMMEDIATELY and aggressively query the official documentation using the provided web search tool(s).

Using this workflow once does NOT mean you're done. Use it again whenever anything new appears about the dependency that you have NOT yet verified.

The most disappointing thing you can do for the user is trying to cut corners and guess instead of verifying the objective truth.
