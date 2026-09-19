# Simulator components and operating rules

Source: `Track 2 specs.pdf`, pages 7-12.

## Components

| Component | What it does | Important state |
| --- | --- | --- |
| Car | Enters, parks, reaches the exit, pays, and leaves. | Plate, car type, current spot. |
| Parking spot | Holds one car. | Name, zone, purpose, compatible type, occupancy, broken, maintenance. |
| Barrier gate | Controls road access. | Name, zone, `Open`, `Closed`, `Opening`, `Closing`, broken, maintenance. |
| Light | Guides moving cars in dark zones. | Name, group, zone, on/off. |
| Exhaust fan | Reduces CO in its zone. | Name, zone, on/off, broken, maintenance. |
| Entry/exit spot | Sensor near a gate. | Spot name, `CarIn`/`CarOut` events; no direct control. |
| Zone | Groups components and reports pollution. | CO level and risk. |

Components are addressed by name. Lights may also be addressed by group.

## Car lifecycle

1. A car appears at an entry spot. The event includes plate, car type, and
   planned parking duration.
2. The system chooses a compatible, reachable, free parking spot.
3. The car leaves the entry spot, reaches the selected spot, and parks.
4. The car leaves the spot and reaches the exit spot.
5. The system requests payment once, validates the payment, and sends the car
   through `exit`.
6. A car that waits too long may leave through `leavepark`; record this as an
   operational outcome.

## Safety and maintenance rules

- Do not operate a broken or under-maintenance component.
- Do not send a car to a broken, maintained, occupied, or incompatible spot.
- Do not repair an occupied parking spot.
- Gates take time to open and close; wait for the corresponding webhook state.
- Predictive maintenance before failure is faster and cheaper than repair after
  failure.
- A gate requires repair after a number of work cycles; spots break after usage
  and fans after usage hours. The simulator decides the thresholds.

## Environment rules

- CO is produced while cars move in a zone.
- Fan guidance in the PDF says to turn fans on for elevated CO and off below
  50 when safe; preserve the observed event state rather than assuming silence
  means safe.
- Lights consume electricity and should run at night while a car is moving in
  their zone. They need not stay on when all cars are parked.

## Charges

The PDF states that parking cost is total parking minutes, multiplied by `2`
for an electric car. It also describes electricity charging as `1` per minute,
multiplied by `2` for an electric car. Confirm the final split and rounding with
the running build before locking billing code.
