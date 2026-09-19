"""Shared helper for tools: resolve the running level's topology the same way the app does."""
from app import topology
from app.config import settings
from app.sim_client import SimClient


def resolve_site(sim: SimClient) -> topology.Topology:
    return topology.resolve(sim.list_parking_spots(), sim.list_barriers(), settings.topology_dir,
                            settings.sim_levels_dir, settings.topology_max_gate_distance)
