# 5 Whys — depth for Phase 3 (Investigate)

Purpose: take ONE likely hypothesis and drive it to the root *condition*, with
evidence at each step. Toyota Production System method, adapted to evidence-based
diagnosis.

## How to run

1. Start from the symptom (or the hypothesis from Phase 2).
2. Ask "why does this happen?" Answer with a **condition that exists**, and cite
   the evidence (file:line, log, data) that shows it. No evidence → it's an
   inference; mark it and go find the evidence before continuing.
3. Repeat on the answer. Continue until the cause is (a) within your control and
   (b) such that removing it would prevent recurrence. Usually 3–5 steps; don't
   force exactly five.
4. Branch when a "why" has more than one supported answer — follow each branch;
   this links back to Fishbone's multiple candidates and keeps you honest.

## Evidence-gated template

```
SYMPTOM: Session expires immediately after mobile login
  Why? Browser doesn't send the session cookie on the callback
       └ evidence: request log shows no Cookie header on /oauth/callback (mobile)
  Why? Cookie is scoped SameSite=Strict
       └ evidence: Startup.cs:142  cookie.SameSite = Strict
  Why? Callback is a cross-site redirect from the OAuth provider
       └ evidence: AuthController.cs:89  redirect to external IdP then back
  ROOT CONDITION: session cookie (SameSite=Strict) is omitted on the cross-site
  OAuth callback, so the session appears unestablished on mobile.
  [in control? YES — cookie config. removal prevents recurrence? YES]
```

## Stop criteria

- The cause is a positive condition you can act on (not "we lack X").
- Going further would leave your system (e.g. "because physics") — stop at the
  controllable boundary.
- Each step is backed by evidence, not narrative.

## Anti-patterns (same spirit as SKILL.md)

- **Single chain blindness** — real causes often branch; don't collapse to one.
- **Blame as a cause** — "human error" is a stop sign, not a root; ask why the
  system allowed it.
- **Absence framing** — "because there was no validation" → restate as the
  condition that existed ("input reached processing unsanitized").
- **Stopping at a symptom** — if removing the "root" wouldn't prevent recurrence,
  you stopped too early.

## Hand-off

The root condition goes into Phase 4 (Formulate) and is scored with the four
readiness questions. If Framing fails (you phrased an absence), fix it here.
