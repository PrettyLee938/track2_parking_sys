# Track 2 simulator references

These pages are a usable Markdown conversion of `Track 2 specs.pdf`.

The PDF is the source of simulator behavior. The repository's design documents
may add implementation choices, but they must not be treated as simulator facts
until confirmed against the running build.

## Pages

- [Challenge overview](./challenge-overview.md) - mission, setup flow, and Level 1 acceptance targets.
- [Simulator settings](./simulator-settings.md) - `settings.json` fields and safe local configuration.
- [Simulator API](./simulator-api.md) - authentication, discovery, and control endpoints.
- [Components and rules](./components-and-rules.md) - cars, spots, gates, lights, fans, zones, and operating rules.
- [Webhooks](./webhooks.md) - event envelope, event classes, and signature validation.
- [Penalties and Level 1](./penalties-level1.md) - penalty triggers and the first judging level.
- [Simulator shortcuts](./simulator-shortcuts.md) - local practice and reset controls.

## Important local integration finding

The simulator currently running on the Windows machine accepts login with the
configured credentials (`POST /api/v1/auth/login` returns `200`). The PDF lists
discovery paths such as `/api/v1/list-parking-spots` and
`/api/v1/list-barriers`. The backend log showed `404` for guessed paths such as
`/api/v1/parking-spots` and `/api/v1/barriers`. The adapter must use the paths
in [Simulator API](./simulator-api.md); changing simulator credentials will not
fix those `404` responses. The documented list paths returned `200` on the local
build. The local `/api/v1/status` response did not contain a `runId`, so the
adapter must not require an undocumented run identifier before it can become
ready.

## Source map

| Markdown page | PDF pages |
| --- | --- |
| Challenge overview | 1, 3-6, 39-40 |
| Simulator settings | 35-36 |
| Simulator API | 13-23 |
| Components and rules | 7-12 |
| Webhooks | 24-32 |
| Penalties and Level 1 | 33-34, 39-40 |
| Simulator shortcuts | 37-38 |
