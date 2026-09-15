# SPEN September launch readiness

This PR is a read-only audit and migration specification, NOT a claim that Meta eligibility or delivery is fixed. It does not register new MCP tools, alter the deployment entrypoint, spend money, create ads, or send conversion events.

## Run

With the existing Meta credential supplied through the environment (never committed), run:

    node scripts/launch-readiness/preflight.mjs
    node --test test/preflight.test.mjs

The audit writes preflight-report.json. Exit 1 means incomplete/error; exit 2 means open gates. It deliberately cannot issue a ready=true certification because live tracking, asset selection and billing require separate evidence. Do not commit reports containing customer data.

## Required migration

Use the four existing replacement campaigns in migration-plan.json. Their lifetime budgets total 700000 minor units (EGP 7000). Keep campaign-level budgets; do not allocate an extra budget to child ad sets. Do not create a second replacement generation. Originals remain paused and retained for rollback. Create eight PAUSED ad sets only after each payload validates, and then create sixteen PAUSED ads reusing verified creative IDs. Exclude both seed ads and Ad09 Educators. Re-read every object after mutation. Never infer success from a name or from a successful upload alone. Approval of this PR does not approve activation.

## Open blockers and acceptance criteria

1. Hourly scheduling: Meta rejected the same ad-set payload only when scheduling was present (100 / 2446196). ADVERTISER is a documented timezone enum; do not blindly replace it with USER. Inspect the sanitized Meta error_user_msg and error_user_title in a restricted diagnostic session. Confirm the account timezone, lifetime CBO eligibility and exact pacing request. Isolate one field at a time using validate_only. This PR does not guess a fix.
2. Audiences: array syntax now exists, but selected account-uploaded videos failed Page association (2654 / 1713216). Resolve the Page-associated video IDs from the actual Page/ad story before building ENGAGEMENT rules using video_view_50_percent. Do not silently replace video viewers with page engagers. Check Instagram coverage separately; uploaded Facebook video IDs do not prove Instagram viewers are included. Check delivery_status and audience size; stagger activation only after sufficient viewers exist.
3. Attribution: one-day click messaging creation validated, but old sets still carry seven days. Create replacement sets with explicit destination and attribution; never try to mutate immutable attribution or destination fields. No duplication of the bad seed settings.
4. Tracking: the ads currently optimize LEAD on pixel 914292181185995. Confirm a real successful form submission produces the matching event in Test Events. Do not count a button click as a completed signup. A ClickUp success redirect to an owned instrumented page or a consented server-side integration may be needed. A hosting/code merge alone does not install either. No fabricated events or signups.
5. Missing educator creative: Ad09 is Parents-only. E-RETARGET has one approved asset; obtain a second educator asset or explicit exception. Do not reuse the Parents image as a substitute.
6. Last-call copy: propose explicit dates instead of today/tomorrow; e.g. Parents: التسجيل متاح لحد الجمعة ٢٥ سبتمبر الساعة ٤ عصرًا. Educators: التسجيل متاح لحد السبت ٢٦ سبتمبر الساعة ٤ عصرًا. These are proposed edits requiring approval, not applied copy. Inspect text embedded in images too. Never change the actual registration deadline based only on an ad cutoff.
7. Identity/destination: inspect every preview on Facebook and Instagram. Older rebuilt image creatives omit instagram_user_id. Verify branding, actual image selection, Arabic shaping, headline, description, CTA and destination. Native SIGN_UP cannot be renamed Register Now. Messaging requires MESSAGE_PAGE and a working inbox. Align Homework's registration wording with the messaging CTA after approval.
8. Billing: account status and payment eligibility must be verified. The balance field is not proof of prepaid funds; do not request a top-up solely from that field.
9. Safety: existing paginated connector responses have included access_token in paging.next. Never repeat/store these URLs. This audit follows cursors while using Authorization headers and removes paging/secrets/URLs from saved diagnostics. The shared connector's response sanitization still needs hardening separately.
10. Campaign-level validation is not full hierarchy validation. Verify ad review issues, video processing, dates and placements on the completed replacements. Starts that have passed must be rescheduled with approval rather than claiming delivery started at the original hour.

## Tests and limits

The isolated audit tests use fixtures, not live credentials. Full repository build, actual Meta validation, migration and activation remain separate steps. No claims of universal API access or guaranteed delivery.

References:
https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/
https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling/
https://developers.facebook.com/docs/marketing-api/guides/videoads/
