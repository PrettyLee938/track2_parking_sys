"""Thin client for the Parking Simulator REST API (/api/v1).

Every protected call carries the bearer token. On a 401 the client logs in again
once and retries, so an expired token never takes the control loop down.

Note: the list-* endpoints carry a simulated operational cost. Call them once at
startup (or after a crash) to sync state, never on a polling loop.
"""
from urllib.parse import quote

import httpx

from app.config import settings


class SimError(Exception):
    pass


class SimClient:
    def __init__(self, base_url=None, user=None, password=None, timeout=None):
        self.base_url = (base_url or settings.sim_base_url).rstrip("/")
        self.user = user or settings.sim_user
        self.password = password or settings.sim_password
        self.token = None
        self.http = httpx.Client(timeout=timeout or settings.sim_timeout_s)

    # ---- auth -------------------------------------------------------------
    def login(self):
        r = self.http.post(f"{self.base_url}/auth/login",
                           json={"Email": self.user, "Password": self.password})
        if r.status_code != 200:
            raise SimError(f"login failed: {r.status_code} {r.text}")
        self.token = r.json()["token"]
        return self.token

    def _request(self, method, path, **kw):
        if self.token is None:
            self.login()
        url = f"{self.base_url}{path}"
        r = self.http.request(method, url, headers={"Authorization": f"Bearer {self.token}"}, **kw)
        if r.status_code == 401:
            self.login()
            r = self.http.request(method, url, headers={"Authorization": f"Bearer {self.token}"}, **kw)
        if r.status_code >= 400:
            raise SimError(f"{method} {path} -> {r.status_code} {r.text}")
        if not r.content:
            return None
        try:
            return r.json()
        except ValueError:
            return r.text

    def _get(self, path):
        return self._request("GET", path)

    def _post(self, path, **kw):
        return self._request("POST", path, **kw)

    # ---- discovery (costly: once per level load) ---------------------------
    def list_parking_spots(self): return self._get("/list-parking-spots")
    def list_barriers(self):      return self._get("/list-barriers")
    def list_lights(self):        return self._get("/list-lights")
    def list_exhaust_fans(self):  return self._get("/list-exhaust-fans")
    def list_alarms(self):        return self._get("/list-alarms")
    def list_zones(self):         return self._get("/list-zones")
    def test_webhook(self):       return self._get("/test")

    # ---- gates --------------------------------------------------------------
    def open_gate(self, name):   return self._post(f"/barrier-gates/{quote(name)}/open")
    def close_gate(self, name):  return self._post(f"/barrier-gates/{quote(name)}/close")
    def repair_gate(self, name): return self._post(f"/barrier-gates/{quote(name)}/repair")

    # ---- lights -------------------------------------------------------------
    def light_on(self, name):        return self._post(f"/lights/{quote(name)}/on")
    def light_off(self, name):       return self._post(f"/lights/{quote(name)}/off")
    def light_group_on(self, group):  return self._post(f"/lights/group/{quote(group)}/on")
    def light_group_off(self, group): return self._post(f"/lights/group/{quote(group)}/off")

    # ---- exhaust fans -------------------------------------------------------
    def fan_on(self, name):     return self._post(f"/exhaust-fans/{quote(name)}/on")
    def fan_off(self, name):    return self._post(f"/exhaust-fans/{quote(name)}/off")
    def repair_fan(self, name): return self._post(f"/exhaust-fans/{quote(name)}/repair")

    # ---- parking spots ------------------------------------------------------
    def repair_spot(self, name): return self._post(f"/parking-spots/{quote(name)}/repair")

    # ---- cars ---------------------------------------------------------------
    def car_goto(self, plate, destination):
        """destination: a parking spot name, 'exit' (pay at exit), or 'leavepark'."""
        return self._post(f"/car/{quote(plate)}/goto/{quote(destination)}")

    def car_charge(self, plate, parking_cost, charging_cost=0.0):
        """Issue the invoice. Must be sent exactly once, only while the car is at the exit spot."""
        return self._post(f"/car/{quote(plate)}/charge",
                          params={"parkingCost": parking_cost, "chargingCost": charging_cost})
