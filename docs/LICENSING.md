# Licensing — options and open questions

A decision record, not a decision. Nothing here has been applied: ÆTHER is still
under **PolyForm Strict License 1.0.0**. This exists so the reasoning is on paper
when the choice is actually made.

Not legal advice. Anything with revenue attached to it is worth a lawyer's hour.

## Three gaps in the current setup

These are true today and worth fixing **whatever licence is chosen**.

### 1. Even local modification is not permitted

PolyForm Strict grants everything *"other than distributing the software **or making
changes or new works based on the software**."*

That second clause is stricter than it usually reads. It means:

- A user cannot legally patch a bug for their own machine.
- A contributor cannot legally fork to open a pull request — a fork is
  redistribution, and a patch is a new work.

So the project cannot accept outside contributions without granting permission
out-of-band first, per contributor, before they have written anything.

### 2. The README promises a CLA that does not exist

> External contributions require a signed Contributor License Agreement (CLA) or
> another written contributor agreement.

There is no `CONTRIBUTING.md`, no CLA text, and no CLA bot. The stated route to
contributing terminates in nothing. Either write it or stop referring to it.

### 3. There is no way to buy a commercial licence

Redistribution and commercial use "require separate written permission from
CanPixel" — and no email, form, or contact appears anywhere in the repository. The
single revenue path the licence exists to protect has no door in it.

This one is worth fixing immediately and costs one line.

## What constrains the choice

**Nothing in the dependency tree.** Gemma 4 E2B/E4B and Qwen3-Embedding-0.6B are
Apache-2.0; llama.cpp, Tauri, and the rest are Apache-2.0/MIT. No copyleft
obligation reaches ÆTHER's own code.

**The product shape does.** ÆTHER is a local desktop app with no server. That rules
out the usual open-core playbook — there is no hosted tier to sell, and AGPL has no
leverage because there is no network service to trigger the source obligation. The
realistic revenue is a one-time purchase or a per-seat commercial licence, which is
what PolyForm already reserves.

**The audience does too.** Researchers, journalists, and people in regulated or
air-gapped environments care about auditability and about not being cut off. Both
argue for source-available with a durable guarantee, and against anything that
makes moving a build onto an offline machine legally awkward.

## Options

### A. PolyForm Noncommercial 1.0.0

Permits modification and redistribution; still bans commercial use.

- Fixes all three frictions: local fixes, sneakernet to an air-gapped machine, PRs.
- Gives up nothing sellable — noncommercial use was already permitted.
- Roughly a one-word change in the licence family, plus `package.json` and README.

The smallest change that removes real friction. Still not OSI open source, so it
does not buy open-source goodwill or a place in distro repositories.

### B. FSL-1.1-Apache-2.0 (Functional Source License)

Same commercial protection now; each release converts to Apache-2.0 two years after
it ships.

- The strongest "this will not be taken away from you" signal short of going open,
  which matters for the trust-sensitive audience.
- Irrevocable per release — a promise that cannot be walked back.
- Two years is a long time in this category; by the time a release converts, it is
  unlikely to be competitive.

### C. AGPL-3.0 + commercial dual licence

Real OSI open source, with a commercial licence sold to anyone who cannot comply.

- Weak here. The copyleft trigger is *conveying* or *network use*; a local desktop
  app with no server rarely trips either, so the commercial pressure that makes
  dual-licensing work mostly is not there.
- A competitor could fork commercially provided they publish source.
- Meaningful legal and administrative overhead for a solo project.

### D. Keep PolyForm Strict, close the gaps

Write the CLA and `CONTRIBUTING.md` the README already promises, add a commercial
contact.

- Zero licence risk, and the documentation is owed regardless.
- Contributors still cannot legally fork to submit a PR, so the contribution path
  stays theoretical.

### E. Fully permissive (Apache-2.0 / MIT)

- Maximum adoption and goodwill.
- No revenue path at all for a local app with no hosted component, and no
  protection against a rebranded fork.

## A correction to the audit that prompted this

The audit said the current setup has *"the costs of proprietary and the revenue of
open source."* That is unfair as written. PolyForm Strict **does** establish the
legal basis for a commercial story — every commercial right is retained. What is
missing is everything on the other side of it: no price, no tier, no contact. Gap 3
above is the real finding; the licence family is a secondary question.

## Suggested order

1. **Add a commercial-licence contact.** One line. Fixes a gap that exists under
   every option, and is the only one currently costing money.
2. **Resolve the CLA claim** — write it, or remove the sentence.
3. **Then** decide between A and B, if either. That decision is about how much
   openness is worth to the audience, not about unblocking anything technical.
