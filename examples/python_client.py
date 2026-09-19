#!/usr/bin/env python3
"""Small standard-library client for the Grand Park Auto control API."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


class ParkingApiClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8080",
        username: str = "admin",
        password: str = "admin",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.authorization = f"Basic {credentials}"

    def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        authenticated: bool = True,
    ) -> object:
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = self.authorization
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()

        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=15) as response:
                payload = response.read().decode()
                return json.loads(payload) if payload else None
        except HTTPError as error:
            payload = error.read().decode()
            try:
                details = json.loads(payload)
            except json.JSONDecodeError:
                details = payload
            raise RuntimeError(f"HTTP {error.code}: {details}") from error
        except URLError as error:
            raise RuntimeError(f"Cannot reach {self.base_url}: {error.reason}") from error

    def get(self, path: str) -> object:
        return self.request("GET", path)

    def post(self, path: str, body: dict | None = None) -> object:
        return self.request("POST", path, body)

    def health(self) -> object:
        return self.request("GET", "/health", authenticated=False)


def encoded(value: str) -> str:
    return quote(value, safe="")


def print_json(value: object) -> None:
    print(json.dumps(value, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default=os.getenv("PARKING_API_URL", "http://127.0.0.1:8080"),
    )
    parser.add_argument("--username", default=os.getenv("PARKING_API_USERNAME", "admin"))
    parser.add_argument("--password", default=os.getenv("PARKING_API_PASSWORD", "admin"))
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("status", help="Show connection and summarized car-park status")
    commands.add_parser("dashboard", help="Show the complete dashboard model")
    commands.add_parser("sync", help="Synchronize once after loading a simulator level")
    commands.add_parser("cars", help="List tracked cars")

    spots = commands.add_parser("spots", help="List parking spots")
    spots.add_argument("--status", choices=["free", "occupied"])
    spots.add_argument("--zone")

    commands.add_parser("barriers", help="List barriers")

    assign = commands.add_parser("assign", help="Assign a compatible free spot to a car")
    assign.add_argument("plate")

    barrier = commands.add_parser("barrier", help="Open, close, or repair a barrier")
    barrier.add_argument("name")
    barrier.add_argument("action", choices=["open", "close", "repair"])

    move = commands.add_parser("move", help="Move a car to a spot, exit, or leavepark")
    move.add_argument("plate")
    move.add_argument("destination")

    quote_command = commands.add_parser("quote", help="Calculate a car's current charge")
    quote_command.add_argument("plate")

    charge = commands.add_parser("charge", help="Charge a car using the calculated quote")
    charge.add_argument("plate")

    leave = commands.add_parser("leave", help="Release a car after payment validation")
    leave.add_argument("plate")

    commands.add_parser("test-webhook", help="Ask the simulator to send a test event")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    client = ParkingApiClient(args.base_url, args.username, args.password)

    try:
        if args.command == "status":
            dashboard = client.get("/api/v1/dashboard")
            print_json(
                {
                    "health": client.health(),
                    "lastSyncAt": dashboard["lastSyncAt"],
                    "lastSequenceId": dashboard["lastSequenceId"],
                    "parking": dashboard["parking"],
                    "barrierCount": len(dashboard["barriers"]),
                    "zoneCount": len(dashboard["zones"]),
                    "activeCars": dashboard["activeCars"],
                }
            )
        elif args.command == "dashboard":
            print_json(client.get("/api/v1/dashboard"))
        elif args.command == "sync":
            print_json(client.post("/api/v1/sync"))
        elif args.command == "cars":
            print_json(client.get("/api/v1/cars?limit=500"))
        elif args.command == "spots":
            query = urlencode(
                {
                    key: value
                    for key, value in {"status": args.status, "zone": args.zone}.items()
                    if value
                }
            )
            suffix = f"?{query}" if query else ""
            print_json(client.get(f"/api/v1/parking-spots{suffix}"))
        elif args.command == "barriers":
            print_json(client.get("/api/v1/barriers"))
        elif args.command == "assign":
            print_json(client.post(f"/api/v1/cars/{encoded(args.plate)}/assign"))
        elif args.command == "barrier":
            print_json(client.post(f"/api/v1/barriers/{encoded(args.name)}/{args.action}"))
        elif args.command == "move":
            print_json(
                client.post(
                    f"/api/v1/cars/{encoded(args.plate)}/goto/{encoded(args.destination)}"
                )
            )
        elif args.command == "quote":
            print_json(client.get(f"/api/v1/cars/{encoded(args.plate)}/quote"))
        elif args.command == "charge":
            print_json(client.post(f"/api/v1/cars/{encoded(args.plate)}/charge", {}))
        elif args.command == "leave":
            print_json(client.post(f"/api/v1/cars/{encoded(args.plate)}/leave"))
        elif args.command == "test-webhook":
            print_json(client.post("/api/v1/simulator/test-webhook"))
        return 0
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
