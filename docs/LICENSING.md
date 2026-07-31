# Licensing — the decision and the reasoning

**ÆTHER is on [PolyForm Strict
1.0.0](https://polyformproject.org/licenses/strict/1.0.0), plus a standing
contribution exception** in [`CONTRIBUTING.md`](../CONTRIBUTING.md). A move to
PolyForm Noncommercial was prepared on 31 July 2026 and reverted the same day; the
reasoning on both sides is kept below, because this question will come back.

The requirement that produced this shape was specific: **contributors must be able
to fork, and nobody may redistribute** — commercially or otherwise. No stock
licence does that. Strict blocks the forking a pull request needs; Noncommercial
permits the redistribution that is the thing to prevent. So the licence stays
Strict and the copyright holder grants a narrow written exception on top of it,
which is a normal thing for a copyright holder to do and keeps the LICENSE file
itself unmodified and standard.

Not legal advice. Anything with revenue attached is worth a lawyer's hour.

## Where Strict actually draws the line

Worth stating plainly, because it is easy to get backwards. Strict and
Noncommercial **both permit noncommercial use**, in identical terms — personal
use, and use by charities, schools, public research bodies and government
institutions regardless of funding.

Neither licence stops the public using ÆTHER for free. What Strict adds is a ban
on **modification and redistribution**:

> the licensor grants you a copyright license ... for any permitted purpose,
> **other than distributing the software or making changes or new works based on
> the software**.

So the choice between them is not "can people use it for free" — that is yes
either way. It is "can people change it and pass it on."

Neither stops the public running ÆTHER for free. If that ever becomes the goal, it
is a different family of licence entirely — see
[If free use is the thing to stop](#if-free-use-is-the-thing-to-stop).

## What Strict costs, and what the exception buys back

Strict alone would mean a user cannot patch a bug on their own machine, and a
contributor cannot legally fork to open a pull request — a fork is redistribution
and a patch is a new work. Both are fixed by the standing grant, which permits
forking and modifying **for the purpose of contributing**, and patching your own
copy for your own use.

What is deliberately _not_ bought back:

- Redistributing ÆTHER to anyone else, modified or not, paid or free.
- Publishing built binaries, installers, or packages.
- Carrying a build to an air-gapped machine that is not yours, which stays
  awkward for an audience that does exactly that. This is the one real cost still
  standing, and it is the price of the redistribution ban.

The grant is scoped tightly on purpose: publishing a contribution fork is allowed
because a pull request mechanically requires it, but using that fork to hand
people a usable alternative build is not.

## The gaps, and where they stand

| Gap                                      | Status                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Even local modification is forbidden     | **Closed** by the standing grant — forking to contribute and patching your own copy are allowed |
| README promised a CLA that did not exist | **Closed** — [`CONTRIBUTING.md`](../CONTRIBUTING.md) carries the contributor terms and the flow |
| No way to buy a commercial licence       | **Closed** — `canpixeldev@gmail.com`, in the README licence section                             |

The third was the one actually costing money: the single revenue path the licence
exists to protect had no door in it.

## If free use is the thing to stop

Neither PolyForm option above does this. If the goal is that the public cannot run
ÆTHER without paying, the licence family has to change entirely:

- **PolyForm Internal Use 1.0.0** — permits use only inside the licensee's own
  organization; no public grant at all.
- **A proprietary EULA** — all rights reserved, use only under a purchased licence.
  Source can still be published for auditability; publishing source and granting a
  licence are separate acts.
- **Free-trial terms** — PolyForm Free Trial 1.0.0 grants 32 days, then nothing.

All three trade away the noncommercial goodwill that Strict currently gives, and
all three need a payment and licence-key path that does not exist yet. That is a
product decision with build work behind it, not a one-line licence swap.

## What constrained the choice

**Nothing in the dependency tree.** Gemma 4 E2B/E4B and Qwen3-Embedding-0.6B are
Apache-2.0; llama.cpp, Tauri, and the rest are Apache-2.0/MIT. No copyleft
obligation reaches ÆTHER's own code.

**The product shape did.** ÆTHER is a local desktop app with no server. That rules
out the open-core playbook — there is no hosted tier to sell — and it defangs
AGPL, whose network-use trigger needs a network service. The realistic revenue is
a one-time purchase or a per-seat commercial licence, which is what PolyForm
reserves.

**The audience did too.** Researchers, journalists, and people in regulated or
air-gapped environments care about auditability and about not being cut off. Both
argue for source-available with a durable guarantee.

**The threat model is not the usual one.** Anti-cloud clauses (FSL, Elastic,
PolyForm Perimeter) exist to stop a hyperscaler reselling your service. The
realistic risk to a desktop app is a rebranded fork on an app store — a different
problem, and one [`TRADEMARKS.md`](../TRADEMARKS.md) addresses independently of the
code licence. A forker can be entitled to the code and still barred from the name.

## The comparison

| Licence                 | Modify | Redistribute | Others' commercial use  | You can sell | OSI              | PRs possible |
| ----------------------- | ------ | ------------ | ----------------------- | ------------ | ---------------- | ------------ |
| **PolyForm Strict** ←   | ✗      | ✗            | ✗                       | ✓            | ✗                | ✗            |
| PolyForm Noncommercial  | ✓      | ✓            | ✗                       | ✓            | ✗                | ✓            |
| PolyForm Small Business | ✓      | ✓            | free under ~100 staff   | ✓            | ✗                | ✓            |
| FSL-1.1-Apache-2.0      | ✓      | ✓            | ✗ (non-compete)         | ✓            | ✗ → ✓ after 2 yr | ✓            |
| BUSL-1.1                | ✓      | ✓            | you define the grant    | ✓            | ✗ → ✓ at date    | ✓            |
| Elastic v2              | ✓      | ✓            | ✗ managed service only  | ✓            | ✗                | ✓            |
| GPL-3.0                 | ✓      | ✓            | ✓ (must publish source) | weak         | ✓                | ✓            |
| AGPL-3.0                | ✓      | ✓            | ✓ (must publish source) | weak         | ✓                | ✓            |
| Apache-2.0 / MIT        | ✓      | ✓            | ✓                       | ✗            | ✓                | ✓            |

\* Modification permitted for contributing and for your own copy; see
[`CONTRIBUTING.md`](../CONTRIBUTING.md). Redistribution stays forbidden either way,
which is what separates this row from PolyForm Noncommercial.

Two notes that change the usual advice for a project shaped like this one:

- **AGPL is the wrong copyleft here.** Its network clause needs a server; with none,
  it degrades to plain GPL-3.0. If copyleft is ever wanted, pick GPL-3.0 knowingly:
  it triggers on _distributing the binary_, which is exactly what a rebranded fork
  would do.
- **"Converts to open source later" is a real signal.** FSL and BUSL make an
  irrevocable per-release promise. That is the strongest anti-lock-in guarantee
  short of going open, and it costs nothing today.

## Still open

Two options remain live, in opposite directions. Which one is right depends on a
question that is not a licensing question: **is the goal more reach, or more
control?**

**Toward more openness — PolyForm Noncommercial, or FSL-1.1-Apache-2.0.** Both
keep the commercial position exactly as it is today; neither gives up anything
sellable. Noncommercial removes the three costs listed above at no revenue cost.
FSL goes further, adding an irrevocable promise that each release becomes
Apache-2.0 two years after it ships — the strongest anti-lock-in signal available
without giving up revenue, and the one most likely to matter to an audience of
researchers and journalists.

**Toward more control — Internal Use, a proprietary EULA, or trial terms.** See
[If free use is the thing to stop](#if-free-use-is-the-thing-to-stop). These
require a payment and licensing path to be built first, and trade away the
noncommercial goodwill Strict currently grants.

Strict sits between the two and commits to neither, which is a reasonable place to
wait — but it is worth being clear that it is a middle position, not a maximally
protective one. It does not stop anyone using ÆTHER for free.
