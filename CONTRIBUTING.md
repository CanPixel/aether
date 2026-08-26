# Contributing to ÆTHER

Contributions are welcome. ÆTHER is licensed under [PolyForm Strict
1.0.0](LICENSE), which by itself permits neither modification nor redistribution —
so the permissions below exist to make contributing possible without opening the
project up to being redistributed.

## Additional permissions granted by CanPixel

These are a standing grant from the copyright holder, on top of the LICENSE. They
apply to everyone, need no prior approval, and can be relied on.

**1. You may fork and modify ÆTHER in order to contribute to it.** That includes
publishing your fork on the hosting platform where this repository lives, because
that is the mechanism a pull request requires. The permission is limited to
preparing, submitting, and revising a contribution to this project.

**2. You may modify your own copy for your own use.** Patching a bug on your
machine, or building a change locally to try it, is permitted for permitted
noncommercial purposes under the LICENSE.

**What these do not permit — and this is the point of them being narrow:**

- Distributing ÆTHER, modified or unmodified, to anyone else. Not commercially,
  not noncommercially, not for free. Publishing a contribution fork is allowed as
  a route to a pull request; using it to hand people a usable alternative build is
  not.
- Publishing or sharing built binaries, installers, or packages of any kind.
- Presenting a fork as a distribution, release, or product. See
  [`TRADEMARKS.md`](TRADEMARKS.md).
- Any commercial use. That needs a separate licence — `canpixeldev@gmail.com`.

If you want to do something these do not cover, ask first; the answer may well be
yes, but it needs to be in writing.

## How to contribute

For anything beyond a typo, **open an issue first**. ÆTHER has opinions and most
are written down: [`docs/PRINCIPLES.md`](docs/PRINCIPLES.md) for what the project
is trying to be, [`docs/SECURITY.md`](docs/SECURITY.md) for the privacy decisions
and why. A change that cuts against one is not unwelcome, but the argument belongs
in the open rather than discovered at review.

Then fork, write it, and open a pull request referencing the issue. A described
bug or a failing test case is a genuinely useful contribution on its own and
carries none of the licence terms below.

## Working on it

Setup and prerequisites are in the [README](README.md#development-prerequisites).
Before opening a pull request:

```bash
pnpm run typecheck   # tsc + cargo check
pnpm run lint        # eslint
pnpm run test        # cargo test --lib
pnpm run format      # prettier
```

Rust also needs to be clippy-clean:

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Two things reviewers will look for:

- **Match the surrounding code.** This codebase comments the _why_, not the what,
  and it is dense with reasoning that is expensive to rediscover. If you change a
  decision, change the comment that explains it.
- **Per-platform code needs per-platform thought.** `src/content_blocking/` and
  `src/browsing_data/` are three separate implementations against three unrelated
  native APIs, and two of the three cannot be compiled on a Mac. CI builds all of
  them; see [`docs/SECURITY.md`](docs/SECURITY.md#verifying-the-platform-code).

## Contributor license terms

**By opening a pull request against this repository, you agree to the following.**

1. **You have the right to contribute it.** The contribution is your own original
   work, or you have the right to submit it under these terms — it is not copied
   from a source whose licence forbids that, and it is not subject to an employer
   or client agreement that would conflict.

2. **You keep your copyright.** You are not assigning it. You retain the right to
   use your own contribution however you like, elsewhere.

3. **You grant CanPixel a licence to it.** Specifically: a perpetual, worldwide,
   non-exclusive, royalty-free, irrevocable licence to use, reproduce, modify,
   distribute, and prepare derivative works of your contribution, **including the
   right to sublicense it and to license it under different terms**.

4. **You grant the same patent licence** that the project licence grants, for any
   patent claims you own that your contribution would otherwise infringe.

Point 3 is the one that matters, so here is what it is for rather than just what
it says. ÆTHER is sold under a commercial licence to anyone whose use is not
noncommercial. If contributed code could only ever be licensed noncommercially,
every commercial release would have to strip it out or negotiate separately with
each contributor. This grant is what keeps the project able to accept your patch
_and_ keep its one revenue path. It does not take anything from you — you keep
your copyright and can reuse your work freely.

> These terms are accepted by the act of opening a pull request. That is lighter
> than a signed agreement and is enough for ordinary contributions. If a
> significant contribution ever needs clean, provable title — an acquisition, a
> large commercial deal — a signed agreement may be requested separately for that
> specific work. Contributors are not lawyers and neither is this file; if you are
> contributing on behalf of an employer, check with them first.

## Branding

The ÆTHER name and marks are not covered by the code licence. See
[`TRADEMARKS.md`](TRADEMARKS.md).

## Commercial licensing

Not a contribution question, but this is where people look: commercial use needs a
separate licence. Write to **canpixeldev@gmail.com**.
