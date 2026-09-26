# Submission preparation

The build brief supplied with this project lists a September 27, 2026, 11:00 AM ET deadline. That deadline remains **unconfirmed**: the [official guide](https://lablab-ibm-bob-2-hackathon-guide.s3.us.cloud-object-storage.appdomain.cloud/index.html), checked September 26, contains Bob-use and evidence requirements but no submission deadline. Confirm the date, timezone, and deliverable rules in the participant's live event portal before relying on the supplied date.

## Participant actions

- [ ] Run a meaningful IBM Bob IDE task, record its actual contribution, and capture its authentic task-session summary in `bob_sessions/`.
- [ ] Review source and commit history for private material, then authorize repository publication. No remote repository has been published by this build.
- [ ] Deploy sample-only mode and test its public URL, route refreshes, and direct rejection of `/api/repositories/import`. See [deployment instructions](deployment.md).
- [ ] Record a video within the supplied three-minute limit, including at least 90 seconds of the working solution. The event portal must confirm these limits.
- [ ] Produce the requested cover image and slides from the actual application. No submission media is currently represented as complete.
- [ ] Replace the pending [Bob usage statement](bob-usage.md) with verified work; keep it within the supplied 500-word limit.
- [ ] Review the problem/solution draft below, add only measurements that exist, and keep it within the supplied 500-word limit.
- [ ] Enter the code repository and application URLs, upload the required media, check access from a signed-out browser, and submit through the event portal.

## Problem/solution statement draft

Developers planning a change often need to inspect several parts of a repository before they can decide what to edit and test. An account-deletion request can touch a settings page, API handlers, authentication, linked records, storage helpers, and documentation. Finding those relationships manually is easy to interrupt and difficult to explain to a reviewer.

Pickle accepts a bounded JavaScript/TypeScript project snapshot, matches a change request to candidate starting files, and asks the developer to confirm those files. It traces supported imports and identifies selected route, schema, environment-name, and document references. Each finding links to paths and source locations from the same snapshot. Structural relationships, inferred references, and unknowns are labeled separately. Review-priority scores show their configured components and do not claim to predict regressions.

The synthetic Pantry sample demonstrates this workflow with existing account read/update routes and a proposed deletion feature. Developers can inspect the graph or file table, review implementation and test tasks, add their own notes, and export Markdown, JSON, or an IBM Bob handoff. The analyzer never executes uploaded code or runs its scripts. Local import sends accepted text to a service on the same machine; the hosted demo allows only the public sample.

Evaluation uses automated parser, relationship, ingestion, ownership, lifecycle, and export checks. Current measured run times and known limits belong in the benchmark record. No manual-review speedup or productivity multiplier is claimed without a measured baseline.

## Delivery status

Source, tests, deployment instructions, and statement drafts are repository artifacts. Publication, a live application URL, authentic Bob evidence, cover image, recorded video, slide deck, and event submission remain participant actions. Check [build progress](build-progress.md) for the actual verification results and any open P0 work.
