# e2e coverage in Scope

These rules add to the Scope skill above. In this repository, Scope decides for every
Proposal rule a request adds or changes whether e2e verifies it, most often for the
`Proposal updated` request. The Proposal no longer marks rules as untested; ignore any
〔不測：…〕 mark still left. `coverage-map.json` records the decision.

This repository's maintained product is the e2e suite. Its scenarios and its coverage map
are development work here, so the work-type gate's "No verification or release
masquerade" check does not turn them away; running a release or deciding one still does.

## Deciding coverage

Decide by Proposal R8.15:

- e2e verifies what users operate directly:
  - `gh nibfin` commands;
  - installing and removing Nibfin and its Runners, collaborator Runners included;
  - the Dashboard and the website;
  - the configuration users write themselves, such as `.nibfin.json` or the Runner
    `.env`;
  - the released artifacts users install, such as the image digest and signature and the
    gh-nibfin releases.
- Nibfin's own development verifies the automatic workflow (Proposal R8.21), and e2e
  does not:
  - the Scope, Shape, Deliver, Accept, Review and Repair stages;
  - dispatch, holds and label reactions;
  - the environment inside a Job.
- A rule that only states a principle, a position or an absence (such as "no timer") has
  nothing a user observes through those interfaces, so it is not e2e either.
- A rule with both kinds of behavior is e2e for its user-operated part; name that part.
- When a rule fits neither side clearly, do not guess: list it in the manifest as a
  decision for the Owner.

A rule the request does not add or change keeps its current entry. A rule the Proposal
deletes keeps its id, as the repository's README says for the map.

## In the Issues

Every Issue that changes `coverage-map.json` lists its rules, one line each, with the
decision:

- e2e: the platforms and the scenarios to add or update;
- not e2e: the reason the `notE2e` field will hold, short and in the Proposal's
  language, like the existing entries.

The manifest lists the same decision for every rule the request adds or changes. A rule
that is not e2e still needs its map entry written, so it belongs to an Issue too; one
Issue may carry several such entries.
