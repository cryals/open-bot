---
name: open-bot-release
description: 'Prepare an Open Bot release, maintain user/developer documentation and screenshots, or verify its Git delivery. Use in cryals/open-bot; report build/CI/environment evidence without treating planned modules as shipped.'
---

# Open Bot release

Locate the checkout, read `AGENTS.md`, `tasks.md` and `docs/developer/workflow.md`. Confirm the requested release scope against code and module catalog. Do not tick unimplemented features because their design exists; distinguish roadmap from current release.

## Documentation and branding

Product name is Open Bot. Community names stay in editable content or actual guild metadata. Update both README files and `scripts/readme-badges.mjs` when the product status changes; regenerate SVGs. A release badge is editorial, CI status must reflect real runs.

User/developer guides live in `docs/user/` and `docs/developer/`, entry `docs/README.md`. The wiki is a separate MkDocs Material site (`mkdocs.yml`, `requirements-docs.txt`), output `site/`. Maintain nav/exclude_docs and keep internal specs/review reports excluded. Do not bundle docs in the admin panel or restore its removed custom /docs renderer.

Capture actual UI with FakeDiscord (`npm run ui:harness`, optionally UI_PORT). Store temporary browser state/traces in ignored `output/playwright/`. Copy only selected clean screenshots into `docs/assets/screenshots/`. For annotations retain the unmodified source and check buttons, labels and states against it. Generated artwork is not evidence of application behavior.

## Validation and rollout

Run checks requested by the user and document exact outcomes. Application gates: `npm run check`, `npm run format:check`, `npm run build`. The wiki uses a separate Python environment and `python -m mkdocs build --strict`. Documentation workflow builds the Pages artifact and deploys main. Check actual account/Pages eligibility; do not change privacy/billing to bypass a failure. Docker runtime remains explicitly unrun on the owner's constrained machine.

Before changing a running installation, preserve its data and coordinate the actual stopped service; do not launch a second supervisor against the same SQLite. Code on disk does not update existing workers. Use the documented backup/restore process for migrations.

## Git delivery

Review the complete diff and stage explicit source/documentation paths. Exclude `.env`, data, output, browser auth state and traces. Commit/push only within user authorization. Fetch and compare local HEAD with the target remote SHA; inspect status and actual workflow results. A billing-blocked CI run proves neither passing nor failing tests. Do not retry it indefinitely or alter account billing.

Report the commit, documentation entry points, real check outcomes and material remaining limitations. Do not create a GitHub release or tag unless requested.
