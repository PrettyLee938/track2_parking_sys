"""The simulator's contract: every literal string the simulator sends or expects.

Nothing else in the codebase should spell these out. If the simulator changes a
name, this is the only file to touch.
"""
from enum import StrEnum

SIM_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


class EventClass(StrEnum):
    COMPONENT_BROKEN = "component_broken"
    COMPONENT_FIXED = "component_fixed"
    CARBON_MONOXIDE = "carbon_monoxide_event"
    CAR_SPOT_ACTION = "car_spot_action"
    GATE_ACTION = "gate_action"
    PAYMENT_MADE = "payment_made"
    PENALTY = "penalty"
    TEST = "test_webhook"


class Direction(StrEnum):
    IN = "CarIn"
    OUT = "CarOut"


class SpotPurpose(StrEnum):
    PARK = "Park"
    ENTRY = "EntrySpot"
    EXIT = "ExitSpot"
    LEAVE = "LeaveParking"


class CarType(StrEnum):
    """Also the parkingForCarType of a spot ('Any' accepts every car)."""
    ANY = "Any"
    NORMAL = "Normal"
    ELECTRIC = "Electric"
    ACCESSIBLE = "Accessible"


class GateState(StrEnum):
    OPEN = "Open"
    CLOSED = "Closed"
    OPENING = "Opening"
    CLOSING = "Closing"


class ComponentType(StrEnum):
    BARRIER_GATE = "BarrierGate"
    PARKING_SPOT = "ParkingSpot"
    EXHAUST_FAN = "ExhaustFan"
    LIGHT = "Light"


class Destination(StrEnum):
    """Special goto targets (anything else is a parking spot name)."""
    EXIT = "exit"            # drive to any exit; payment is requested there
    LEAVE_PARK = "leavepark"  # leave through an escape route


class PenaltyReason(StrEnum):
    """Case-insensitive substrings of penalty Reason texts we react to."""
    CHARGE_NOT_AT_EXIT = "charged at the exit"
    # "Car is being charged wrongly with amount: (2.00). Car type is (Normal) so charge should be: (4.00)"
    CHARGED_WRONGLY = "charged wrongly"


# Extracts the correct amount from a CHARGED_WRONGLY penalty reason.
CORRECT_AMOUNT_PATTERN = r"should be:\s*\(([\d.]+)\)"
