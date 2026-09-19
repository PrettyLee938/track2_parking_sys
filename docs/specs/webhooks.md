# Simulator webhooks

Source: `Track 2 specs.pdf`, pages 24-32.

Webhooks are HTTP JSON requests sent to `WebhookUrl`. They report events,
payments, failures, and penalties.

## Common envelope

Every event uses these control fields:

| Field | Use |
| --- | --- |
| `EventClass` | Selects the event handler. |
| `EventId` | Unique event identity; deduplicate before processing. |
| `SequenceId` | Increasing sequence; detect gaps, duplicates, and reordering. |
| `Signature` | MD5 integrity value; validate before domain processing. |
| `ServerDateTime` | Simulator event time. |

The documented event classes are `component_broken`, `component_fixed`,
`carbon_monoxide_event`, `car_spot_action`, `gate_action`, `payment_made`,
`penalty`, and `test_webhook`.

## Event payloads

| Event | Important fields | Meaning |
| --- | --- | --- |
| `component_broken` | `Type`, `Name`, `FineAmount` | A component failed. |
| `component_fixed` | `Type`, `Name`, `RepairCost` | A repair completed. |
| `carbon_monoxide_event` | `ZoneName`, `CarbonMonoxideLevel`, `DangerLevel` | CO reached `Mid` or higher. |
| `car_spot_action` | `CarPlateNumber`, `CarType`, `SpotName`, `SpotType`, `Direction`, `PlannedParkingDurationInMinutes` | A car entered or left an entry, parking, or exit spot. |
| `gate_action` | `Name`, `Action` | A gate changed state. |
| `payment_made` | `CarPlateNumber`, `Amount`, `Reason` | A payment notification arrived; it may be fake. |
| `penalty` | `Reason`, `FineAmount`, `Type`, `ComponentName` | The simulator applied a fine. |

For car events, `Direction` is `CarIn` or `CarOut`, and `SpotType` is `Park`,
`EntrySpot`, or `ExitSpot`. The normal path is `ENTRY1/CarIn`,
`ENTRY1/CarOut`, parking spot `CarIn`, parking spot `CarOut`, `EXIT/CarIn`,
then `EXIT/CarOut`.

## Signature validation

1. Remove `Signature` from the JSON object.
2. Sort the remaining field names alphabetically.
3. Read their values in that order and join them with `|`.
4. Compute lowercase MD5 of the joined string.
5. Compare it with the received `Signature`.

Example canonical string from the PDF:

```text
WAW 228|CarOut|car_spot_action|efa2d3ac-1a6e-47d4-9099-3457270e30ee|0|2026-09-12 14:51:37|405|2026-09-12 14:25:50|ENTRY1|EntrySpot
```

Store the raw payload, calculated digest, received digest, and validation
result. A missing or `null` signature is not valid evidence; reject it before
changing parking, payment, or equipment state and record a security incident.
