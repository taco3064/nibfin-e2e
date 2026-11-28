---
root: true
targets: ["*"]
description: "Where the Nibfin product authority is and how to read it"
globs: ["**/*"]
---

# Product authority

The product authority for this repository is the Nibfin Proposal, a Notion page
written in Traditional Chinese:

https://app.notion.com/p/40006b644a2080dab1a8c2e562f95373

- Read it with the Notion tools before you rely on, cite or check a product
  clause. Every rule is one bullet with a fixed id such as `R5.12` (section 5,
  rule 12). Cite rules by that id, for example "Proposal R5.12", in Issues
  (Authority), Shapes, reviews and e2e coverage maps. Older references such as
  "Proposal §5" mean that whole section of this page.
- Rule ids are never reused or renumbered, so an id keeps pointing at the same
  rule after edits. The reasons and decision history sit in each section's 紀錄
  toggle and are not rules.
- The Proposal does not say which rules e2e covers. nibfin-e2e's coverage map
  decides that and records why a rule is not covered (Proposal R8.15); ignore
  any 〔不測：…〕 mark still left on a rule or quoted in an Issue. e2e covers
  only what users operate directly: `gh nibfin` commands, install and removal,
  the Dashboard, the website, collaborator Runners, the configuration users
  write themselves and the released artifacts they install.
  Nibfin's automatic workflow is verified by Nibfin's own development.
- Its child pages are not product rules: 進度 is the progress log, Nibfin 自身
  Repository 的使用設定 is how Nibfin's own repositories are set up, and the
  封存 pages are archives for history only. None of them override the main page.
- The Notion tools may load on demand: search for them (for example "notion
  fetch") instead of assuming they are absent. Fetch the page by the URL above.
- The Proposal is read-only for you. Never create, edit, move or comment on
  Notion pages; a needed change to the Proposal is a finding you report.
- If the Notion tools are not available or the page cannot be read, say so in
  your result and rely only on the clauses quoted in the Issue; do not guess the
  rest of the Proposal.
