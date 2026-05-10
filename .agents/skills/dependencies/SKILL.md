---
name: dependencies
description: Use when ANY dependency gets into your context window (i.e. if you're tasked with using an SDK, need to confirm some primitive, review some implementation, change a config, etc.) that in theory COULD have changed since your knowledge cutoff ~6 months ago. Invoking this skill saves the user money, decreases your total workload, and DRASTICALLY improves end results - a win-win-win for everyone.
---

For each dependency that you're working with, proactively consider if it COULD have changed since your knowledge cutoff point MONTHS ago. If yes, then:

1. Ensure it's git cloned to ../sources and run the ../sync.sh script.
   > If `../sources` is missing, clone `https://github.com/sloikodavidodavid/sources`.
2. Proactively query the cloned dependency source code through a subagent, or analyze it yourself for a more expensive but raw understanding.

If the source code isn't available, IMMEDIATELY start aggressively querying the official documentation using your provided web search tool(s).

Even if you've already used this workflow once, that doesn't mean you shouldn't do it again if ANYTHING new comes up related to the dependency, that you have NOT yet verified.

The worst thing you can do for the user is try to guess things instead of verifying.
