# Product

## Register

product

## Users

The primary users are the engineers grading a take-home for Paytm Money's _Deploy & Observe_ round. They open the live URL on a laptop, usually alongside a terminal running their own burst script. Within minutes they want to know whether the service stays correct under a stampede and whether they can see that happening. Secondary users are the people standing in for the audience: anyone who signs in with a demo username to pick seats in a hall.

They do three jobs:

1. Watch a hall fill live, and book or hold seats as a user.
2. Check correctness at a glance: the invariant badge, audit verdicts, decline reasons, and latency.
3. Fire a stampede from the browser and read the outcome.

## Product Purpose

FirstDayFirstShow (FDFS) sells numbered seats for a show and stays correct when the whole city storms the first show on release day: no double-sell, no user over the limit, idempotent retries, no 5xx. The UI makes that correctness visible and checkable while the system runs, rather than asking the reader to trust a README. It succeeds when a grader can watch a 20k-request burst land and tell from the screen alone that the books balanced.

## Brand Personality

Theatrical but precise. The darkness of a cinema hall and the glow of the screen, with marquee warmth used sparingly. Every number is exact, labelled and legible, like a control room. Confident, unhurried and technical: the voice of an engineer showing their work, not a marketer.

## Anti-references

- Generic SaaS dashboards: purple gradients, hero-metric tiles, identical icon-card grids.
- A BookMyShow or Paytm Movies clone: consumer-ticketing chrome, promo banners, poster carousels.
- Neon "cyberpunk" or terminal cosplay that sacrifices legibility for mood.

## Design Principles

1. **Show, don't claim.** Correctness is on screen: live counts that reconcile, audit verdicts, and decline reasons with request ids.
2. **The hall is the hero.** The seat map is the main surface; everything else supports reading it.
3. **Exact over approximate.** Real numbers with units, from the server, never decorative stats.
4. **Calm under load.** The UI stays readable and steady while thousands of seats flip. Motion explains change; it never adds noise.
5. **Honest states.** Loading, empty, declined, expired, offline and reconnecting are all designed, not afterthoughts.

## Accessibility & Inclusion

- WCAG 2.2 AA contrast for all text and meaningful UI.
- Seat state is never conveyed by color alone (shape or glyph differs too).
- The seat map is keyboard-operable, with screen-reader labels per seat.
- `prefers-reduced-motion` is honoured everywhere.
