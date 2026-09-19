# Penalties and Level 1 checklist

Source: `Track 2 specs.pdf`, pages 33-34 and 39-40.

Penalties are credits deducted when a requirement is violated. The simulator
sends a `penalty` webhook with the reason and amount. Early levels apply only
the penalties for features present in that level; later levels add more.

## Penalty triggers

- `Penalty_ItemBrokenDueToMissingPredictiveMaintenance`
- `Penalty_SendCarToBrokenOrUnderMaintenanceSpot`
- `Penalty_CarParkedInWrongSpotType`
- `Penalty_OperateElementWhileUnderRepair`
- `Penalty_ChargeCarForParkingTwice`
- `Penalty_ChargeCarWhileNotAtExitSpot`
- `Penalty_ChargeCarForNoElectricityUsed`
- `Penalty_CarChargedIncorrectParkingAmount`
- `Penalty_RepairAnOccupiedSpot`
- `Penalty_SendCarToOccupiedSpot`
- `Penalty_CarEscapedWithoutPaying`
- `Penalty_CarLeftFromEntryBecauseNeglected`
- `Penalty_ZonePollutedWithHighCO`

## Level 1 acceptance checklist

- [ ] Backend logs in to the simulator and calls the documented listing and
  control APIs.
- [ ] Webhook listener receives and stores events.
- [ ] Duplicate `EventId` values do not repeat state changes.
- [ ] Arrival handling selects a compatible free spot and guides the car.
- [ ] Gate state, spot occupancy, and free capacity are visible in the web UI.
- [ ] Exit handling calculates the correct charge and asks for payment once.
- [ ] Fake, wrong, early, or duplicate payments cannot authorize departure.
- [ ] A confirmed paid car can leave through the exit path.
- [ ] Admin and Operator authentication and permissions work.
- [ ] Arrivals, parking time, departures, charges, and penalties are searchable.
- [ ] The system remains truthful after a simulator or backend restart.

## Success criterion

Keep cars moving, keep parking spaces organized, and keep the car park running
smoothly at full capacity. The presentation should show the dashboard and the
simulator together, with observed events and charges rather than invented
success metrics.
