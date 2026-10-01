---
name: senior-engineering
description: Prefer readable, maintainable, reliable, explicitly tested implementations for all repository work.
applyTo: "**"
---

# Senior Engineering Standards

## Instruction Hierarchy

- This file defines the default engineering rules. More specific instruction files add only their domain-specific requirements.
- When instructions conflict, follow the most specific applicable rule, then this file, then general preferences.
- Keep instruction files lightweight. Record only repository-specific constraints or non-obvious practices; put detailed procedures in focused reference files.
- Avoid duplicating rules between instruction files. Update the owning file instead.

## Design And Implementation

- Make the smallest change that fixes the root cause.
- Match the surrounding code's established naming, structure, comment density, error-handling, and testing patterns unless a change is needed for correctness.
- Surface all configuration, protocol, and hardware constants to the top of the module in a dedicated constants section (positioned directly after imports and before mutable runtime state). Never bury configuration constants in downstream domain sections, inside functions, or at arbitrary call sites, and never conflate immutable constants with mutable runtime state.
- Before adding a new function, constant, state holder, handler, module, or feature path, read the complete owning module and identify its established sections, ownership boundaries, dependency direction, and entry points. Classify the new code by its responsibility, then place it in the matching section and dependency order: configuration constants surfaced in the top constants section, mutable state with state, reusable helpers with related helpers, policy or business logic with its owner, and side-effecting handlers or initialization at the relevant lifecycle boundary. Do not append declarations at the nearest call site, bottom of a file, or another convenient location merely to make the code work.
- Treat a feature as a coherent architectural change rather than a collection of disconnected insertions. Follow the module's existing organization when adding its related constants, state, helpers, orchestration, handlers, and tests; do not interleave unrelated concerns just to minimize the diff. If no existing section or owner fits, create the smallest clear section, helper boundary, or module boundary that matches repository conventions before adding the feature logic.
- Before changing existing code, identify the owning function or module's logical phases and place new code in the matching phase. Preserve established grouping such as input/state capture, validation and guards, decision branches, effects, and cleanup; do not insert declarations or conditions merely beside their immediate use.
- When modifying a function, first read its complete control flow and keep related declarations, derived values, guards, decisions, effects, and cleanup together in their established order. Add a value at the start of its logical phase, not halfway through later control flow because it is used there. Do not scatter a single concern across unrelated branches; extract a small named helper or make the smallest coherent refactor when the new behavior does not fit one existing phase cleanly.
- Optimize for the next maintainer: prefer clear, explicit code over clever abstractions, generic metadata, and premature frameworks.
- Preserve existing APIs, local conventions, and user changes unless a change is required for correctness.
- Keep external protocol values at a clear boundary with named constants surfaced in the top constants section. Do not scatter ad hoc strings through business logic.
- Use names that express business meaning and match the value's actual type and purpose.
- Prefer small named predicates or explicit branches when they are clearer than maps, reducers, classes, or normalization layers.
- Keep transient runtime state local. Do not introduce RunVariables or persistence unless the requirement explicitly needs shared or durable state.

## State And Reliability

- Identify the real source of truth before adding cached state.
- Model finite states explicitly and handle unknown values safely.
- Consider startup synchronization, event ordering, duplicate events, stale timers, asynchronous races, and recovery paths.
- Handle every external command and asynchronous operation deliberately with error handling.
- Fail closed for safety-sensitive actions and log enough context to explain the decision.

## Testing And Verification

- Before editing, state one falsifiable hypothesis and one focused check.
- Add a regression test for the reported failure, including relevant state transitions and boundary conditions.
- Ensure tests can observe the behavior that was previously broken; a test that merely executes code is insufficient.
- Prefer detailed existing tests, specifications, mockups, and production evidence over high-level summaries when resolving ambiguity.
- Run the narrowest relevant executable check immediately after an edit, then broaden validation when practical.
- Verify changed files directly and do not claim completion based only on an edit tool response or a successful command.

## Review And Communication

- Review for correctness, regressions, maintainability, readability, performance, and security.
- Lead reviews with concrete findings ordered by severity and grounded in file references.
- State assumptions and tradeoffs plainly.
- Do not add abstraction unless it removes real complexity or matches an established pattern.
- Do not claim completion without executable or authoritative verification.
