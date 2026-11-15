# Guest Messaging and Access-Code Runbook

This runbook separates automations controlled by this repository from messages
that must be managed in Lodgify's dashboard. Use a dry run before every live
configuration change.

## Canonical sequence

| Timing | Message | Owner | Required behavior |
| --- | --- | --- | --- |
| Immediately after booking | Booking confirmation / next steps | Lodgify dashboard | Confirm reservation and explain that the required guest form must be completed before access details are released. |
| 2 days before arrival | Form reminder 1 | Admin automation | Send only when the required form is incomplete. Link to the reservation-specific internal form. |
| 1 day before arrival | Form reminder 2 | Admin automation | Repeat only if incomplete. Do not disclose the access code. |
| Arrival day | Final form reminder | Admin automation | Send only if incomplete and provide a clear support path. |
| Day before arrival at 3:00 PM Central | Check-in information / access code | Admin automation | Release only after the form gate passes. |
| Arrival day at 11:00 AM Central | Delayed-unit access code | Admin automation | Applies to Doodle House (static lockbox code) when configured; release only after the form gate passes. |
| Before checkout | Checkout reminder | Lodgify dashboard | Use the canonical 11:00 AM checkout time and concise departure instructions. |

## Code-managed automations

- `waiverReminders` controls the 2-day, 1-day, and arrival-day form reminders.
- `accessCodeRelease` controls eligibility, scheduling, Jervis retrieval,
  Lodgify delivery, retry state, and email fallback for configured channels.
- The internal `welcome-to-zenfulcove` form is canonical. Jotform remains a
  fallback for historical reservations during migration.
- Access-code delivery must remain disabled until the dry-run output and one
  controlled reservation test pass.
- Never place static guest door codes in templates. Use reservation-scoped data
  from Jervis/Lodgify at send time.

## Lodgify-dashboard audit

Review these notifications in Lodgify before enabling overlapping code-managed
messages:

- Initial booking confirmation.
- Checkout reminder.
- Any legacy 14-day kayak notification; disable it if the current guest sequence
  already provides the Guest Portal and water-safety information.
- Old Jotform links, outdated house names, outdated website URLs, duplicate
  access-code messages, and obsolete check-in times.

Export or screenshot the active Lodgify notification matrix before editing so
the previous state can be reconstructed.

## Safe validation sequence

1. Confirm the internal form slug, Lodgify property IDs, Jervis property
   mappings, Central-time schedules, and delivery-channel fallbacks.
2. Run waiver and access-code tests in dry-run mode. Confirm that complete and
   incomplete form states take opposite branches.
3. Verify Doodle House uses the delayed schedule while other
   units use the standard schedule.
4. Use one controlled future reservation belonging to the team. Complete its
   form, confirm the correct Jervis code and validity window, then send one test
   message.
5. Confirm the message appears once in the intended Lodgify/channel thread and
   that retry state prevents a duplicate.
6. Enable the production automation only after the controlled test passes.

## Acceptance checks

- No form: no access code.
- Completed form: the correct reservation-specific code is eligible at the
  configured time.
- Cancelled or ineligible booking: no send.
- A prior successful delivery: no duplicate.
- Missing Jervis code or failed route verification: retry/fallback is logged;
  no guessed code is sent.
- Every message uses the correct unit name, check-in time, checkout time, Guest
  Portal/form link, and support contact.
