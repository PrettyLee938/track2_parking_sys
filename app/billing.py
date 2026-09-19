"""Parking charge rules. Rates and rounding come from settings (GPA_PRICE_PER_MINUTE,
GPA_ELECTRIC_MULTIPLIER, GPA_BILLING_ROUNDING).

Durations passed in here are GAME seconds (already scaled from wall-clock by the
controller's learned time scale).
"""
import math

from app.config import Rounding, Settings, settings as default_settings
from app.protocol import CarType


def billable_minutes(game_seconds: float, planned_minutes: int | None, cfg: Settings = default_settings) -> int:
    if cfg.billing_rounding == Rounding.PLANNED and planned_minutes:
        return planned_minutes
    minutes = game_seconds / 60
    if cfg.billing_rounding == Rounding.CEIL:
        return max(1, math.ceil(minutes - 1e-9))
    return max(1, round(minutes))


def parking_cost(game_seconds: float, planned_minutes: int | None, car_type: str,
                 cfg: Settings = default_settings) -> float:
    cost = billable_minutes(game_seconds, planned_minutes, cfg) * cfg.price_per_minute
    if (car_type or "").lower() == CarType.ELECTRIC.lower():
        cost *= cfg.electric_multiplier
    return round(cost, 2)


def charging_cost(car_type: str, cfg: Settings = default_settings) -> float:
    # No level so far reports how much electricity a car drew. Billing electricity
    # that was not used is a penalty (Penalty_ChargeCarForNoElectricityUsed), so this
    # stays 0 until an event tells us the amount.
    return 0.0
