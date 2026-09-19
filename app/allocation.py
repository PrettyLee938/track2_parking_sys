"""Spot allocation strategies: which free spot an arriving car is sent to.

Pick one with GPA_ALLOCATION_STRATEGY. To add a strategy, subclass Allocator and
register it in STRATEGIES.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Iterable

from app.protocol import CarType, SpotPurpose

if TYPE_CHECKING:
    from app.controller import Spot


def spot_number(name: str) -> int:
    digits = "".join(ch for ch in name if ch.isdigit())
    return int(digits) if digits else 10**9


class Allocator:
    """Base: any free spot of a compatible type, in any zone."""
    name = "any_zone_first_free"

    def in_scope(self, spot: Spot, lane_zone: str, all_spots: Iterable[Spot]) -> bool:
        return True

    def candidates(self, car_type: str, lane_zone: str, spots: Iterable[Spot]) -> list[Spot]:
        spots = list(spots)
        return [s for s in spots if s.available and s.accepts(car_type) and self.in_scope(s, lane_zone, spots)]

    def shares_pool(self, zone_a: str, zone_b: str) -> bool:
        """Whether cars queued at lanes of these two zones compete for the same spots."""
        return True

    def rank(self, spot: Spot, car_type: str):
        # A spot built for this car type first (an electric car to a charger), then
        # generic spots. Normal cars never reach typed spots: accepts() excludes them.
        return (spot.car_type == CarType.ANY, spot_number(spot.name))

    def choose(self, car_type: str, lane_zone: str, spots: Iterable[Spot]) -> Spot | None:
        found = self.candidates(car_type, lane_zone, spots)
        return min(found, key=lambda s: self.rank(s, car_type)) if found else None


class LaneZoneAllocator(Allocator):
    """Only spots in the zone the entry lane leads to. Zones marked 'Closed' in the
    simulator are separate areas: a car sent to another zone may not reach it. Falls
    back to every zone when the lane's zone is unknown or has no parking at all."""
    name = "lane_zone_first_free"

    def in_scope(self, spot, lane_zone, all_spots):
        if not lane_zone or not any(s.zone == lane_zone and s.purpose == SpotPurpose.PARK for s in all_spots):
            return True
        return spot.zone == lane_zone

    def shares_pool(self, zone_a, zone_b):
        return not zone_a or not zone_b or zone_a == zone_b


STRATEGIES: dict[str, type[Allocator]] = {cls.name: cls for cls in (Allocator, LaneZoneAllocator)}


def get(name: str) -> Allocator:
    try:
        return STRATEGIES[name]()
    except KeyError:
        raise ValueError(f"unknown allocation strategy {name!r}; choose from {sorted(STRATEGIES)}") from None
