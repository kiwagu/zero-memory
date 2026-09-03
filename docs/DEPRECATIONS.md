---
title: Deprecations
description: Contract deprecations, compatibility windows, and breaking changes for MCP and HTTP clients.
---

What has been deprecated in the MCP tool and HTTP contract, when, and what to
use instead. This ledger is the notice period: anything listed here still
works until the stated release, so an existing client has time to move.

Version numbers below are values of `CONTRACT_VERSION` (exported from
`@workspace/contracts`, and announced on the MCP `initialize` handshake as the
`zero-memory/contract` experimental capability). It is semver over the contract
itself, independent of any package version:

- **major** — a breaking change: a field removed or renamed, a type narrowed, a
  tool withdrawn.
- **minor** — an additive change: a new optional field, a new tool, a new enum
  member in a field clients only read.
- **patch** — wording only.

## Rules for adding an entry

1. Add the row in the SAME change that introduces the replacement — a
   deprecation without a documented successor is just a removal announcement.
2. Keep the deprecated surface working. Deprecating is a promise, not a
   removal.
3. Removal lands no earlier than the next **major**, and never in the release
   that announces the deprecation.
4. Announce in the release notes as well; a client that never reads this page
   still needs to hear about it.

## Deprecated surfaces

| Surface | Deprecated in | Replacement | Removal no earlier than |
| ------- | ------------- | ----------- | ----------------------- |

_Nothing is deprecated yet._

## Breaking changes

| Change | Version | What a client must do |
| ------ | ------- | --------------------- |

_None recorded. The ledger starts counting from the first public release —
contract history from before any external client existed is not
compatibility anyone must migrate across, so it is not carried here._

## Behavioural changes

Changes that leave the contract's **shape** untouched — no field moved, no
type narrowed, no code added to the vocabulary — but change what a client
observes. They carry no version bump, because there is nothing to migrate;
they are listed so a client that branched on the old behaviour can find out
why it changed.

| Change | What a client should know |
| ------ | ------------------------- |

_None recorded since the first public release._
