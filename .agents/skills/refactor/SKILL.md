---
name: refactor
description: Use when the user wants to improve codebase architecture, design or review interfaces, deepen shallow modules, consolidate tightly-coupled code, improve testability, run TDD against a design, make code easier to navigate, or find refactoring opportunities.
---

# Refactor

Find architectural friction and propose **deepening opportunities**: changes that turn shallow modules into deep ones.

The goal is better **locality**, better **leverage**, better tests, and a codebase that is easier for humans and AI agents to navigate.

This skill is not for adding architecture theatre. It is for making the code easier to understand, easier to change, easier to test, and harder to accidentally break.

## Language

Use this vocabulary consistently:

- **Module** - anything with an interface and an implementation: function, class, package, feature slice, subsystem, CLI command, workflow, server route, or integration.
- **Interface** - everything a caller must know to use a module correctly: types, invariants, ordering, error modes, config, performance expectations, side effects, lifecycle, and behavior. Not just the type signature.
- **Implementation** - the code inside a module.
- **Depth** - leverage at the interface. A deep module hides a lot of behavior behind a small interface. A shallow module exposes an interface nearly as complex as its implementation.
- **Seam** - where an interface lives; a place behavior can be changed without editing callers.
- **Adapter** - a concrete implementation that satisfies an interface at a seam.
- **Port** - the interface at a seam when the dependency crosses a meaningful boundary.
- **Leverage** - what callers get from depth: more capability per thing they need to understand.
- **Locality** - what maintainers get from depth: change, bugs, knowledge, and tests concentrated in one place.
- **Behavior** - what the caller or user can observe.
- **Scenario** - a concrete example that proves whether the interface actually works.

Use these words exactly when making architecture suggestions. Do not drift into vague words like component, service, API, layer, boundary, helper, manager, utility, engine, orchestrator, or handler unless the codebase already uses them as exact domain terms.

## Principles

- **The deletion test:** imagine deleting the module. If complexity vanishes, it was probably pass-through. If complexity spreads across callers, the module was earning its keep.
- **The interface is the test surface:** callers and tests should cross the same seam.
- **One adapter = hypothetical seam. Two adapters = real seam.** Do not create seams just because they feel architecturally tidy.
- **Depth is not implementation size.** A deep module can be small. A large module can still be shallow.
- **A module earns its name by hiding decisions.** If callers still need to understand the same decisions, the module is probably shallow.
- **A seam should protect callers from change.** If a change behind the seam still forces callers to change, the seam is in the wrong place or the interface is leaking.
- **Tests should verify behavior, not implementation.** If a refactor breaks a test but behavior did not change, the test was probably coupled to internals.
- **Mock at real seams only.** Prefer real code paths, local substitutes, fakes, or adapters over mocking your own modules.
- **Do not introduce indirection without variation.** If nothing varies, do not add a port, adapter, strategy, factory, registry, provider, or abstraction.
- **Prefer fewer, stronger modules over many tiny pass-through modules.** Small files are not the same thing as simple architecture.
- **Do not hide real findings.** Rank them instead. The user should see the full material refactor landscape, not a teaser list.

## Explore

Explore the codebase before proposing changes.

Look for friction:

- Understanding one concept requires bouncing between many small files.
- Modules are shallow: their interface is nearly as complex as their implementation.
- Callers know too much ordering, config, state, error handling, lifecycle, or implementation detail.
- Callers repeat the same defensive checks, normalization, validation, branching, or setup.
- Extracted pure functions make tests easier, but real bugs still hide in orchestration.
- Tightly-coupled modules pretend to be separate.
- Tests are brittle because they test internals instead of behavior through an interface.
- A concept has no clear home, so related behavior is scattered.
- Names do not line up with responsibilities.
- Public functions are named after implementation steps instead of caller goals.
- File structure forces readers to understand technical categories before domain concepts.
- The code is hard for an AI agent to navigate because naming, files, and responsibility do not line up.
- The same dependency is configured, wrapped, or handled in multiple places.
- Error handling policy is copied across callers instead of owned by one module.
- Feature code knows too much about infrastructure details.
- Infrastructure code knows too much about feature rules.
- Tests need huge setup because the interface is too wide or too low-level.
- Tests use mocks because the real interface is hard to exercise.
- A change that feels conceptually small requires edits across many files.
- Compatibility code is mixed into the new design instead of isolated at the edge.
- Old tests freeze shallow architecture instead of protecting behavior.

Apply the deletion test to suspected shallow modules.

For each suspected module, ask:

- What complexity does this module hide?
- What decisions does this module own?
- What do callers still need to know?
- If this module disappeared, where would the complexity go?
- Are callers using this module to express intent, or just to route data somewhere else?
- Would a new contributor know when to use this module?
- Would an AI agent know where to make a change without scanning half the repo?

## Present findings

Present the full architectural analysis from the inspected codebase.

Do not artificially limit the number of findings. Include every material refactoring opportunity that has concrete evidence. Rank findings by importance so the user can tell what matters most.

Use these priority groups:

- **Must fix** - currently harming correctness, testability, locality, or change speed.
- **Should fix** - clear architectural improvement with good evidence.
- **Could fix later** - real issue, but not urgent.
- **Do not fix** - tempting refactor that would likely add churn, abstraction, or indirection without enough payoff.

For each material finding, include:

- **Files** - the files/modules involved.
- **Problem** - the architectural friction.
- **Evidence** - concrete code patterns that prove it.
- **Fix** - what should change in plain English.
- **New module shape** - what the improved module would own.
- **Caller impact** - what callers no longer need to know.
- **Test impact** - what tests become simpler, stronger, or deletable.
- **Compatibility impact** - whether compatibility matters and what type.
- **Why it helps** - explain in terms of locality and leverage.
- **Risk** - what could go wrong or what tradeoff the change introduces.
- **Priority** - must/should/could/do-not-fix.
- **Confidence** - high/medium/low, based on inspected code.

Be complete enough that the user can understand the whole refactor landscape from one response.

Do not stop after a small candidate list unless the user explicitly asked for a quick scan.

Do not hide findings merely because there are many. Collapse duplicates, group related issues, and rank them. Suppression is worse than structured abundance.

Do not ask the user which candidate to explore unless implementation requires a product decision, compatibility decision, public API decision, or migration-risk decision that the code cannot answer.

When useful, include lightweight interface sketches immediately. Do not withhold better shapes just because the user did not explicitly ask for implementation. Keep sketches short during analysis, but include enough shape that the user can judge whether the refactor is real or vague.

End with a recommended execution order:

1. First change to make.
2. Second change to make.
3. Changes to avoid for now.
4. Tests to add before or during the refactor.
5. Compatibility decisions that must be made before implementation.

## Finding quality bar

A good finding usually has at least two of these:

- Multiple callers repeat the same knowledge.
- Tests are awkward because behavior crosses too many small modules.
- The same concept appears under several names.
- A dependency detail leaks into feature logic.
- A feature rule is split across unrelated files.
- A "helper" or "utils" module has become a dumping ground.
- A module mostly passes arguments through.
- A module exists only because tests needed something to mock.
- A change in one concept requires edits in many places.
- The interface forces callers to perform setup in the right order.
- Error handling is duplicated or inconsistent.
- The public name describes how the code works instead of what it means.
- Compatibility logic is deforming the clean design.
- Tests protect old structure instead of current behavior.

A bad finding is usually one of these:

- Aesthetic rearrangement.
- Abstraction for a single use with no variation.
- Extracting code only to make files smaller.
- Introducing a port because "clean architecture."
- Creating a generic framework before real use cases exist.
- Renaming without improving ownership, interface, or tests.
- Moving code without reducing caller knowledge.
- Adding a seam where tests could have used the real implementation.
- Preserving compatibility without naming who benefits from it.
- Deleting compatibility without checking persisted data, public APIs, CLIs, schemas, package exports, or user-authored config.

## Grill the highest-priority design

After presenting findings, grill the highest-priority design before changing code.

If the user selected a finding, grill that one. If the user did not select one, grill the highest-priority finding yourself.

Do not ask one question at a time by default. Answer design questions from the codebase where possible. Only ask the user when the answer depends on product intent, compatibility promises, public API stability, user-facing behavior, or acceptable migration risk.

Walk the design tree:

- What concept should own this behavior?
- What should the module hide?
- What should callers still be allowed to choose?
- What should callers no longer be allowed to know?
- What invariants should the interface enforce?
- What ordering should the interface remove?
- What errors should the module absorb, normalize, or expose?
- What configuration belongs inside the module?
- What configuration must stay outside?
- Which dependencies are real seams?
- Which dependencies are just implementation details?
- Which tests should survive the refactor?
- Which tests should be deleted after deeper tests exist?
- What would make this design overbuilt?
- What would make this design too shallow?

For each load-bearing question:

- State the question.
- Give the recommended answer.
- Explain the evidence.
- Mark whether it is resolved or unresolved.

Rules:

- Surface hidden assumptions, missing constraints, fuzzy language, overloaded terms, and skipped decisions.
- Challenge the design against the existing code, naming, tests, and project constraints.
- Stress-test with concrete scenarios, edge cases, and counterexamples.
- Prefer answering from inspected code over asking the user.
- Keep an explicit unresolved list.
- Do not proceed to implementation while a load-bearing decision is still fuzzy.

## Backwards compatibility questioning

Before designing the new shape, explicitly question whether backwards compatibility should exist at all.

Backwards compatibility is not automatically good. It has a cost: extra code, weaker interfaces, migration drag, more tests, more branches, and more old concepts surviving longer than they deserve.

Ask first:

- Do we want backwards compatibility here at all?
- Who or what depends on the current behavior?
- Are those dependents internal, external, user-authored, persisted, published, or undocumented?
- Is the old behavior part of a real contract, or just current implementation shape?
- Would breaking compatibility create user pain, data loss, deployment risk, or only temporary code churn?
- Is this a library/API/schema/CLI behavior where compatibility matters more?
- Is this private app code where compatibility matters less?
- Would preserving compatibility make the new interface worse?
- Would a clean break be cheaper and safer?

If backwards compatibility is needed, make it granular. Do not preserve everything blindly.

Question compatibility by type:

- **Call-site compatibility** - should old callers keep compiling/running?
- **Behavior compatibility** - should the same inputs produce the same observable outputs?
- **Data compatibility** - should old persisted data/config/files still load?
- **Schema compatibility** - should old manifests, JSON, database rows, or API payloads still work?
- **CLI compatibility** - should old commands, flags, env vars, exit codes, and stdout/stderr shapes still work?
- **Import compatibility** - should old module paths and exported names still work?
- **Error compatibility** - should old error types, messages, codes, and failure modes remain stable?
- **Timing/lifecycle compatibility** - should ordering, startup, shutdown, retries, or scheduling behavior stay the same?
- **Test compatibility** - should old tests survive, or should they be deleted because they freeze the shallow design?

For each compatibility promise, ask:

- Who benefits from preserving this?
- What code does this force us to keep?
- What does this prevent the new design from becoming?
- How long should this compatibility last?
- Can this be handled with a temporary compatibility wrapper?
- What is the removal plan?
- What test proves the compatibility promise?
- What test proves the new behavior?

Prefer explicit compatibility choices:

- **No compatibility** - clean break; update callers directly.
- **Temporary wrapper** - old interface delegates to the new module during migration.
- **Soft compatibility** - old inputs still work, but warnings/deprecations guide users forward.
- **Hard compatibility** - old behavior is treated as a real contract and tested long-term.
- **Data migration** - old stored shape is converted once, then the old path is deleted.
- **Dual-read/single-write** - read old and new shapes, but only write the new shape.
- **Versioned interface** - support old and new versions deliberately when external users need it.

Default stance:

- For private internal code, prefer clean breaks and direct caller updates.
- For persisted data, user-authored config, public APIs, CLIs, schemas, and package exports, assume compatibility matters until proven otherwise.
- Never let compatibility silently deform the new interface.
- If compatibility is needed, isolate it in a wrapper, adapter, migration, or versioned path.
- Compatibility belongs at the edge. The deep module should represent the better shape.

## Concrete scenarios

Use scenarios to force precision.

Good scenarios include:

- The boring happy path.
- The most common caller path.
- An invalid input path.
- A dependency failure path.
- A retry/idempotency path when relevant.
- A partial success path when relevant.
- A stale state or race path when relevant.
- A migration/backward compatibility path when relevant.
- A "new caller next month" path.
- A "test wants to verify this behavior" path.

For each scenario, ask:

- What should the caller do?
- What should the module do?
- What should be impossible?
- What should be observable?
- What should be hidden?
- What should the test assert?

Use scenario answers to validate or reject the proposed interface.

## Design the interface

When the shape is clear, propose 2-3 alternative interfaces for the deepened module.

Each design should include:

- **Interface** - functions, types, methods, parameters, invariants, ordering, error modes, lifecycle, and side effects.
- **Caller example** - what normal use looks like.
- **Hidden implementation** - what moves behind the seam.
- **Dependency strategy** - which dependencies are internal, which are ports, and which adapters exist.
- **Testing strategy** - how tests cross the interface.
- **Migration path** - how to move from current code to new shape safely.
- **Compatibility stance** - no compatibility, temporary wrapper, soft compatibility, hard compatibility, data migration, dual-read/single-write, or versioned interface.
- **Tradeoffs** - locality, leverage, seam placement, flexibility, compatibility cost, and risk.

Make the designs meaningfully different. Do not present tiny variations.

Useful design constraints:

- **Minimal interface** - 1-3 entry points, maximum leverage per entry point.
- **Common caller optimized** - the default path is trivial.
- **Explicit lifecycle** - setup/start/stop/cleanup are impossible to misuse.
- **Dependency isolation** - external systems sit behind clear ports.
- **Functional core** - pure decision logic separated from effectful shell where useful.
- **Compatibility wrapper** - old callers can migrate gradually when compatibility is deliberately needed.
- **Strict domain interface** - caller talks in domain concepts, not infrastructure concepts.

Then recommend the strongest design. Be opinionated. Do not dump a menu and refuse to choose.

## Interface quality checklist

A good interface usually:

- Makes the common case obvious.
- Makes invalid states hard or impossible.
- Hides ordering requirements.
- Hides configuration details that callers should not care about.
- Hides dependency quirks.
- Produces useful errors at the right level.
- Uses names from the problem, not from the implementation.
- Lets tests describe behavior through the same surface callers use.
- Has fewer methods than the implementation has concepts.
- Keeps extension points internal until variation is real.
- Lets new callers use the module without reading the implementation.
- Keeps compatibility code outside the clean interface when possible.

A bad interface usually:

- Mirrors the implementation step-by-step.
- Requires callers to call methods in a fragile order.
- Exposes flags that represent internal branches.
- Accepts giant option objects with unclear invariants.
- Makes tests assert on call counts or internal state.
- Requires mocks for code the project owns.
- Leaks HTTP, database, filesystem, process, or SDK details into feature callers.
- Has names like `Manager`, `Service`, `Helper`, `Utils`, `Handler`, or `Processor` without a precise meaning.
- Preserves old behavior by making the new interface worse.

## Handle dependencies

Classify dependencies before deciding seam shape.

### In-process

Pure computation or in-memory state.

Usually deepen directly and test through the new interface.

Examples:

- parsing.
- validation.
- normalization.
- planning.
- routing decisions.
- state transitions.
- command construction.

Do not create a port just to test this. Test the behavior directly.

### Local-substitutable

Dependencies with local substitutes.

Examples:

- filesystem.
- SQLite.
- Postgres via PGLite/Testcontainers.
- queues with local/in-memory stand-ins.
- local HTTP servers.
- fake clocks.
- temp directories.

Prefer testing the deep module with the local substitute instead of mocking every operation.

### Remote but owned

Your own service across HTTP, gRPC, queue, process, or worker boundary.

Put a port at the seam when the network boundary is meaningful.

Production gets a real adapter. Tests get an in-memory adapter or local fake.

The deep module should own the business logic. The adapter should own transport details.

### True external

Third-party services you do not control.

Examples:

- Stripe.
- Twilio.
- GitHub.
- OpenAI.
- cloud provider APIs.
- email providers.
- payment processors.

Inject a port and use a fake or mock adapter in tests.

Keep SDK types and SDK errors out of feature callers unless exposing them is deliberate.

## Seam discipline

Before adding a seam, ask:

- What varies across this seam?
- Do we have at least two real adapters?
- Is one adapter production and one adapter test?
- Is the test adapter actually valuable?
- Is the seam protecting callers from change?
- Is the seam just hiding a single function call?
- Would the code be simpler if this stayed internal?
- Is this seam public because behavior varies, or because the implementation was hard to test?

Do not expose internal seams through the public interface just because tests need them.

A deep module can have internal seams used by its own tests. Callers should not see them unless they represent real variation.

## Testing strategy

Use tests to prove the architecture, not freeze the implementation.

Good tests:

- Verify observable behavior through public interfaces.
- Exercise real code paths.
- Read like specifications.
- Survive internal refactors.
- Keep setup small because the interface is small.
- Use real collaborators when they are cheap and deterministic.
- Use fakes/adapters at real seams.
- Assert outcomes, not implementation steps.
- Prove compatibility only for promises deliberately kept.

Bad tests:

- Mock internal collaborators.
- Test private methods.
- Assert on internal call counts or ordering.
- Break when implementation changes but behavior does not.
- Verify through side channels instead of the public interface.
- Duplicate the implementation logic in the assertion.
- Require huge setup because the interface is too low-level.
- Pass even when the user-facing behavior is broken.
- Freeze old shallow seams after the deeper interface exists.

Prefer tests named after behavior:

```text
GOOD:
- creates a workflow from a valid manifest.
- rejects a step that references a missing dependency.
- resumes a waiting run when the webhook payload arrives.

BAD:
- calls parseManifest with expected args.
- invokes StepResolver.resolve twice.
- saves row to workflow_runs table.
```

## TDD loop

When building or changing behavior, prefer vertical TDD:

```text
RED:   Write one behavior test.
GREEN: Write the smallest implementation that passes.
REPEAT: Add the next behavior test.
REFACTOR: Improve structure only after tests are green.
```

Do NOT write all tests first, then all implementation.

That is horizontal slicing:

```text
WRONG:
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT:
  RED->GREEN: test1->impl1
  RED->GREEN: test2->impl2
  RED->GREEN: test3->impl3
```

Why vertical slicing is better:

- Each test responds to what was learned from the previous cycle.
- Tests describe real behavior, not imagined structure.
- The implementation gets pressure-tested before the next test is written.
- The interface evolves from actual usage.
- The agent does not outrun its headlights.

Per cycle:

```text
[ ] Test describes behavior, not implementation.
[ ] Test uses the public interface.
[ ] Test fails for the expected reason.
[ ] Implementation is the smallest useful change.
[ ] No speculative feature was added.
[ ] Existing tests still pass.
[ ] Refactor only happens after green.
```

Never refactor while red unless the test itself is invalid. Get to green first.

## Mocking rules

Mock at system seams only:

- true external APIs.
- time.
- randomness.
- network failure.
- filesystem when a temp directory is not enough.
- database when a real/local database is too expensive.
- process boundaries.
- queues when a local fake is clearer.

Do not mock:

- your own modules.
- internal collaborators.
- private methods.
- functions you control.
- code that could be exercised cheaply through the public interface.

If a test needs to mock your own module, ask whether the module seam is wrong.

## Designing for mockability without mock-driven design

Accept dependencies instead of creating them internally when the dependency is a real seam:

```typescript
// Better
function processPayment(order, paymentGateway) {
	return paymentGateway.charge(order.total);
}

// Worse
function processPayment(order) {
	const gateway = new StripeGateway(process.env.STRIPE_KEY);
	return gateway.charge(order.total);
}
```

Prefer specific dependency interfaces over generic fetchers:

```typescript
// Better
const usersApi = {
	getUser: (id) => fetch(`/users/${id}`),
	getOrders: (userId) => fetch(`/users/${userId}/orders`),
	createOrder: (data) => fetch("/orders", { method: "POST", body: data })
};

// Worse
const api = {
	fetch: (endpoint, options) => fetch(endpoint, options)
};
```

Specific dependency interfaces make tests clearer because each operation has one shape and one meaning.

Do not turn this into mock-first architecture. The goal is a good interface, not easy mocking for its own sake.

## Refactor strategy

After behavior is green, look for refactor moves:

- Combine shallow modules.
- Move repeated caller knowledge into one module.
- Replace wide interfaces with narrower, deeper ones.
- Move feature rules out of infrastructure glue.
- Move infrastructure quirks behind adapters.
- Collapse duplicate names for the same concept.
- Delete pass-through wrappers.
- Delete redundant tests that only covered old shallow seams.
- Rename modules so names match responsibilities.
- Move validation/normalization to the module that owns the invariant.
- Replace flag-heavy interfaces with clearer operations or types.
- Replace primitive obsession with precise values only when it reduces caller knowledge.
- Keep private helpers private; do not test them directly.
- Move compatibility handling to wrappers, adapters, migrations, or versioned paths.
- Delete compatibility code once the migration window is over.

Run tests after each meaningful refactor step.

## Migration strategy

Prefer safe migrations, but do not preserve compatibility by default.

First decide whether compatibility is actually needed. Internal callers can often be updated directly. Public APIs, CLIs, schemas, package exports, persisted data, and user-authored config need more care.

Useful migration moves:

- Add the new deep module beside the old code.
- Route one caller through it.
- Add behavior tests at the new interface.
- Move remaining callers gradually.
- Use a temporary compatibility wrapper only when it reduces real migration risk.
- Keep compatibility code outside the new module when possible.
- Convert old data/config at the edge before it reaches the new module.
- Delete old pass-through modules after callers move.
- Delete old tests that freeze the shallow structure.
- Add compatibility tests only for promises you deliberately keep.
- Remove compatibility wrappers once they stop earning their keep.

Do not leave both old and new architectures permanently unless they represent real different use cases.

Do not let backwards compatibility pollute the new interface. Compatibility belongs at the edge; the deep module should represent the better shape.

## Output style

Be direct and opinionated.

Do not say "consider" when the evidence is strong. Say what should happen.

When unsure, say what evidence is missing and how to find it.

Prefer concrete file/module references over generic advice.

Prefer complete ranked analysis over artificially small candidate lists.

Prefer interface sketches over vague design advice when the shape is clear.

Do not ask the user to pick from a menu unless a real product, compatibility,
