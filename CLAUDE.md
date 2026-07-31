# Moxa App Builder POC — Project Context

Two related but separate initiatives live in this repo's scope:

1. **CF-publish → email notification POC** — implemented, working, in `actions/generic/`.
2. **BYOM / dynamic product page generation** — researched, NOT yet implemented here.

---

## 1. CF-publish → email notification (DONE, working end-to-end)

**Flow:** AEM Content Fragment published → Adobe I/O Events fires
`aem.sites.contentFragment.published` → invokes `moxademopoc/generic` (a non-web
Runtime action) → builds an email from the real event data → sends via SendGrid →
recipients in `NOTIFY_EMAILS` get notified.

### Key files
- `actions/generic/index.js` — the whole pipeline: receives the event, builds the
  email (see the clearly-marked "EMAIL CONTENT" section at the top), sends via SendGrid.
- `actions/publish-events/index.js` — **unrelated leftover scaffolding** from
  `aio app init` (it's for *publishing* your own custom events to I/O Events, not
  consuming AEM's). Not used by this POC; safe to ignore or delete later.
- `app.config.yaml` — `generic` is configured as `web: 'no'` (critical, see gotcha below).
- `.env` — holds `SENDGRID_API_KEY` (and an unused leftover `RESEND_API_KEY`).

### Confirmed real event payload shape (captured from a live activation log)
```json
{
  "type": "aem.sites.contentFragment.published",
  "data": {
    "path": "/content/dam/lifetech/content-fragments/test-cf",
    "model": { "path": "/conf/wknd-shared/settings/dam/cfm/models/article" },
    "tier": "publish",
    "sourceUrl": "https://publish-p170892-e1840404.adobeaemcloud.com",
    "user": { "displayName": "Deepti Baijal", "principalId": "dbaijal@adobe.com" }
  },
  "time": "2026-07-22T08:47:36.249368067Z"
}
```
`time` is top-level on the event, not nested under `data`. There's a dedicated
`.published` event type (not just a generic `.modified` one), so no filtering logic
is needed to detect "was this specifically a publish."

### Hard-won gotchas (don't redo this debugging)
- **Event-consuming actions must be non-web actions** (`web: 'no'` in
  `app.config.yaml`), invoked directly by Adobe I/O Runtime's internal mechanism —
  NOT `web: 'yes'` web actions. Confirmed against Adobe's own reference:
  https://developer.adobe.com/events/docs/guides/appbuilder/
  A `web: 'yes'` action goes through the public HTTP gateway and its
  `require-adobe-auth`/`__secured_*` machinery, which caused repeated
  `400 missing header(s) 'authorization'` errors — solving the wrong problem.
- Once switched to `web: 'no'`, no `require-adobe-auth` complexity applies at all
  (kept as `false` for cleanliness, but it's largely moot for non-web actions).
- The Developer Console event registration's "Runtime Action" target does **not**
  auto-follow changes to an action's `web`/`require-adobe-auth` settings — after
  changing those and redeploying, you must go back into the event registration and
  re-select the (now differently-named) action from the dropdown.
- Debug Tracing's "204" response only confirms **event delivery**, not that the
  action itself ran without error — always cross-check `aio rt activation list` /
  `aio rt activation logs <id>` (or, easier, make the action return
  `{ statusCode, body }` — Adobe's own reference sample does this even for non-web
  actions, and Debug Tracing's "Response body" panel reads from `.body`
  specifically; a plain object return shows an empty body there).
- Switched from Resend to **SendGrid** specifically because Resend's
  sandbox/unverified-domain sender (`onboarding@resend.dev`) can only send to the
  Resend account's own email — not to colleagues. SendGrid's single-sender
  verification (verify one address via email confirmation, no DNS/domain-admin
  needed) allows sending to any recipient once verified.

### Remaining setup for the user
- Verify `dbaijal@adobe.com` as a Single Sender in SendGrid
  (Settings → Sender Authentication → Single Sender Verification).
- Put the SendGrid API key in `.env` as `SENDGRID_API_KEY`.
- Add colleagues' emails to the `NOTIFY_EMAILS` array in `actions/generic/index.js`.
- Redeploy with `aio app deploy` after any change.

---

## 2. BYOM / dynamic product page generation (RESEARCHED, not yet built)

**Original idea:** one App Builder action takes a path like
`/products/eds-4008-series/eds-4008-lv`, calls Moxa's catalog API, and gets that
page live on EDS — for large product catalogs where hand-authoring every
series/model page isn't feasible.

**Architecture landed on (BYOM = "Bring Your Own Markup",
https://www.aem.live/developer/byom):** the App Builder action itself becomes the
markup content source EDS pulls from — not something that writes to AEM JCR.

```
1. Action hosts a GET endpoint returning semantic HTML for a given path
2. EDS is configured (fstab.yaml or admin config API) to treat that action's URL
   as the content.source (or content.overlay) with type: "markup"
3. Calling the standard Helix Admin API:
     POST /preview/{org}/{repo}/{ref}{path}
     POST /live/{org}/{repo}/{ref}{path}
   makes EDS fetch from the action, convert, and publish
```

### Reference repos studied (clone these again if picking this up)
- `github.com/larsauffarth/byom-demo` — minimal, working 2-action reference:
  `webhook` (calls Helix Admin API preview→verify→live) +
  `data-provider` (the actual BYOM markup generator, Handlebars-rendered).
  Real `config/site-config.json` shows the overlay wiring:
  `content.overlay.url` = the deployed action's own URL.
- `github.com/adobe-rnd/aem-commerce-prerender` — production-grade version of the
  same idea, for real commerce catalogs. Has 5 actions: `fetch-all-products`,
  `check-product-changes` (the real engine — hash-based change detection, state
  tracking via `@adobe/aio-lib-files`, batching with `p-limit`, a "running" lock via
  `@adobe/aio-lib-state` with TTL, deletion handling), `pdp-renderer` (the BYOM
  markup action, structurally identical to `data-provider` above), `get-overlay-url`,
  `mark-up-clean-up`. `docs/CUSTOMIZE.md` in that repo is the guide for adapting the
  rendering logic to a non-Commerce data source (i.e. Moxa's catalog API).

### Decision: keep the POC simple, skip production complexity
Explicitly decided NOT to build the state-tracking/hashing/batching/locking/cron
machinery for the POC — no control over Moxa's PIM update cadence anyway, so
there's no "detect what changed" problem to solve yet. Minimal POC shape:
- **Action 1** ("generate-markup", BYOM source): parse path → call catalog API
  (or mocked data first) → return semantic HTML directly.
- **Action 2** ("trigger-publish", manually invoked for the demo): call
  Helix Admin API preview, then live, for a given path.
No cron, no hash comparison, no state file, no deletion handling.

### Still needed to start building this part
1. Moxa catalog API access (real, or build against mocked data first and swap later).
2. org/repo/ref + a Helix Admin token for the target EDS site.
3. Series vs. model page block/section structure (hero, specs, downloads, etc.).

---

## General App Builder concepts established during this work
(useful context for either part above)
- An action is just a Node.js function; **what it does** (call APIs, write AEM,
  read/write storage, send email) is independent of **how it's invoked** (direct
  HTTP call, called by an external system like Helix Admin API, cron/alarm trigger,
  or an Adobe I/O Events subscription).
- `aio rt activation list` / `aio rt activation logs <id>` are the ground-truth way
  to check what an action actually did — don't trust a delivery-layer status code alone.
