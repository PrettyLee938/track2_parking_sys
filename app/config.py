"""Application settings.

Resolution order (highest wins): environment variables > .env file > defaults below.
Every variable is prefixed GPA_, e.g. GPA_SIM_BASE_URL, GPA_BILLING_ROUNDING.
See .env.example for the full list.

Site-specific layout (which gate serves which entry/exit) is NOT configured here;
it lives in topology/*.json - see app/topology.py.
"""
from enum import StrEnum
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Rounding(StrEnum):
    PLANNED = "planned"  # the driver's planned duration (what the simulator checks against)
    ROUND = "round"      # measured game minutes, nearest whole minute
    CEIL = "ceil"        # measured game minutes, any started minute counts


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GPA_", env_file=".env", extra="ignore")

    # ---- simulator connection ------------------------------------------------
    # Use 127.0.0.1, not "localhost": on Windows "localhost" tries IPv6 first and
    # costs ~2s per request before falling back to IPv4.
    sim_base_url: str = "http://127.0.0.1:9898/api/v1"
    sim_user: str = "admin"
    sim_password: str = "admin"
    sim_timeout_s: float = Field(5.0, gt=0)

    # ---- this server ----------------------------------------------------------
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    log_level: str = "INFO"

    # ---- behaviour switches ---------------------------------------------------
    # 0/false = passive listener (log events, send no commands). Use it with
    # tools/single_car_test.py, which drives cars by hand.
    controller_enabled: bool = True
    # Level 1 sends Signature=null. Turn on once a level signs its webhooks, so
    # unsigned events are dropped as untrusted.
    require_signature: bool = False

    # ---- site layout ----------------------------------------------------------
    topology_dir: Path = Path("topology")
    # Optional: the simulator's settings folder (contains lvl*.json). When no
    # topology file matches the running level, gates are paired from these layouts.
    sim_levels_dir: Path | None = None
    # Max distance (sim units) between a sensor and the gate paired with it.
    topology_max_gate_distance: float = Field(400, gt=0)

    # ---- spot allocation ------------------------------------------------------
    # See app/allocation.py for the available strategies.
    allocation_strategy: str = "lane_zone_first_free"

    # ---- billing (spec: 1 per minute, x2 if electric) -------------------------
    # "planned" matched the simulator's own expected amount in 14/14 rejected bills at
    # game speed 1.7, where measured clock time was 1.7x too short.
    billing_rounding: Rounding = Rounding.PLANNED
    price_per_minute: float = Field(1.0, ge=0)
    electric_multiplier: float = Field(2.0, ge=0)
    payment_tolerance: float = Field(0.005, ge=0)
    # When the simulator rejects a bill and states the correct amount, bill that amount
    # instead of leaving the car stuck (and blocking) the exit.
    recharge_on_wrong_amount: bool = True

    # ---- game clock ------------------------------------------------------------------
    # Webhook timestamps are wall-clock; the simulator's own minutes run GameSpeedMultiplier
    # times faster. The ratio is learned from completed stays (planned game time / measured
    # real time); this is the value used until enough stays have been seen.
    initial_time_scale: float = Field(1.0, gt=0)
    time_scale_samples: int = Field(30, ge=1)

    # ---- timing (real seconds) -------------------------------------------------
    tick_interval_s: float = Field(0.5, gt=0)
    # Charging the instant EXIT CarIn arrives is rejected ("Car should be charged at
    # the exit") - the sensor needs < 1s to settle.
    exit_charge_delay_s: float = Field(1.5, ge=0)
    exit_charge_retry_s: float = Field(2.0, ge=0)
    max_charge_attempts: int = Field(3, ge=1)
    # Let the car clear the barrier before closing it.
    gate_close_delay_s: float = Field(3.0, ge=0)
    # The simulator sometimes never confirms a gate opening. After this long the open
    # command is re-sent once; after the same again, the gate is assumed open.
    gate_open_timeout_s: float = Field(4.0, gt=0)
    # A dispatched car that has not left its entry spot in this time gets its goto
    # re-sent, then is given up on so the lane keeps moving.
    entry_dispatch_timeout_s: float = Field(20.0, gt=0)
    max_dispatch_retries: int = Field(1, ge=0)
    # Cars give up after ~5 game-minutes at an entry (GAME seconds; converted to real
    # time with the learned time scale).
    entry_patience_s: float = Field(290.0, gt=0)

    # Close any open gate nobody is using when syncing (levels start with exit gates open).
    close_idle_gates_on_sync: bool = True
    # No webhook for this long usually means the simulator was restarted or reloaded:
    # re-read spots and gates on the next event.
    resync_after_silence_s: float = Field(20.0, gt=0)

    # ---- storage & recovery ------------------------------------------------------
    data_dir: Path = Path("data")
    # On startup, rebuild car state by replaying our own event log over this window...
    replay_window_s: float = Field(1800.0, ge=0)
    # ...but only if the log is fresh. A newer gap means we were down long enough that
    # the simulator was probably restarted, and replaying would resurrect stale cars.
    replay_max_gap_s: float = Field(120.0, ge=0)
    # A plate that paid this recently and shows up at an exit again is the same
    # session looping, not a new one: never bill it twice.
    repeat_exit_window_s: float = Field(600.0, ge=0)

    # ---- in-memory history sizes (dashboard) -----------------------------------
    feed_size: int = Field(300, gt=0)
    completed_sessions_size: int = Field(500, gt=0)
    recent_events_size: int = Field(300, gt=0)

    @property
    def event_log_path(self) -> Path:
        return self.data_dir / "events.jsonl"


settings = Settings()
