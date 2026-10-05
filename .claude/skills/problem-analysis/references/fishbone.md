# Fishbone (Ishikawa) — breadth for Phase 2 (Hypothesize)

Purpose: generate **distinct** candidate causes across categories so you don't
tunnel on the first guess. Feeds the hypothesis table in Phase 2.

## How to run

1. Write the **effect** (the problem statement from Phase 1) at the head.
2. For each category below, ask "what condition in this category could produce
   the effect?" Record candidates as **conditions that exist**, never as
   absences (see the Problem/Solution Boundary in SKILL.md).
3. From the populated categories, lift the 2–4 strongest, most *distinct*
   candidates into the Phase-2 hypothesis table (each with mechanism + location).
4. Hand the chosen hypothesis to **5 Whys** (`5-whys.md`) in Phase 3 to drill it.

## Categories

**6M (manufacturing / general / software-ops):**

| Category | Prompt for software/system problems |
|----------|-------------------------------------|
| **Man** (people) | skills, fatigue, handoffs, on-call gaps, who-did-what |
| **Machine** (tooling/infra) | hardware, runtime, dependencies, network, limits |
| **Method** (process) | procedures, config, deploy flow, retries, ordering |
| **Material** (inputs/data) | input data shape, payloads, env vars, feature flags |
| **Measurement** | logging, metrics, clock/timezone, sampling, false signals |
| **Mother-Nature** (environment) | load, concurrency, time-of-day, region, external services |

**Service variant (4S)** if the problem is a service/ops interaction, use instead
of 6M: Surroundings, Suppliers, Systems, Skills.

## Is / Is-Not companion (sharpen the boundary first)

Before or alongside Fishbone, contrast what the problem **IS** vs what it **IS
NOT** but plausibly could be — the difference localizes the cause.

| Dimension | IS (affected) | IS-NOT (could be, isn't) | What the contrast implies |
|-----------|---------------|--------------------------|---------------------------|
| What | mobile login | desktop login | something mobile-specific |
| Where | OAuth callback | same-site form post | cross-site navigation |
| When | after redirect | before redirect | state lost at redirect |
| Extent | all mobile users | — | systemic, not per-user |

## Output

A categorized candidate list, then the Phase-2 hypothesis table. Mark each
candidate as **observation** (seen in evidence) or **inference** (reasoned).
Discard categories with no plausible mechanism — don't pad to fill all six.
