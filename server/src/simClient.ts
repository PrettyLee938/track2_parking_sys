/**
 * Thin client for the Parking Simulator REST API (/api/v1).
 *
 * Every protected call carries the bearer token. On a 401 the client logs in again
 * once and retries, so an expired token never takes the control loop down.
 *
 * The list-* endpoints carry a simulated operational cost: call them once at startup
 * (or after a crash / level change) to sync state, never on a polling loop.
 */
import type { SimAlarm, SimBarrier, SimExhaustFan, SimLight, SimParkingSpot, SimZone } from "@gpa/shared";
import type { Settings } from "./config";

export class SimError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) { super(message); }
}

/** What the controller and subsystems need from the simulator (a fake implements it in tests). */
export interface SimApi {
  listParkingSpots(): Promise<SimParkingSpot[]>;
  listBarriers(): Promise<SimBarrier[]>;
  listLights(): Promise<SimLight[]>;
  listExhaustFans(): Promise<SimExhaustFan[]>;
  listAlarms(): Promise<SimAlarm[]>;
  listZones(): Promise<SimZone[]>;
  openGate(name: string): Promise<void>;
  closeGate(name: string): Promise<void>;
  carGoto(plate: string, destination: string): Promise<void>;
  carCharge(plate: string, parkingCost: number, chargingCost: number): Promise<void>;
  repairGate(name: string): Promise<void>;
  repairSpot(name: string): Promise<void>;
  repairFan(name: string): Promise<void>;
  fanOn(name: string): Promise<void>;
  fanOff(name: string): Promise<void>;
  lightOn(name: string): Promise<void>;
  lightOff(name: string): Promise<void>;
  lightGroupOn(group: string): Promise<void>;
  lightGroupOff(group: string): Promise<void>;
}

export class SimClient implements SimApi {
  private token: string | null = null;
  private readonly baseUrl: string;

  constructor(private readonly cfg: Pick<Settings, "simBaseUrl" | "simUser" | "simPassword" | "simTimeoutS">) {
    this.baseUrl = cfg.simBaseUrl.replace(/\/$/, "");
  }

  // ---- auth -----------------------------------------------------------------
  async login(): Promise<string> {
    const r = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Email: this.cfg.simUser, Password: this.cfg.simPassword }),
      signal: AbortSignal.timeout(this.cfg.simTimeoutS * 1000),
    });
    if (r.status !== 200) throw new SimError(`login failed: ${r.status} ${await r.text()}`);
    this.token = ((await r.json()) as { token: string }).token;
    return this.token;
  }

  private async request<T>(method: "GET" | "POST", path: string): Promise<T> {
    if (!this.token) await this.login();
    const send = () =>
      fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.cfg.simTimeoutS * 1000),
      });
    let r: Response;
    try {
      r = await send();
    } catch (err) {
      throw new SimError(`${method} ${path} failed before a response: ${(err as Error).message}`, true);
    }
    if (r.status === 401) {
      await this.login();
      try {
        r = await send();
      } catch (err) {
        throw new SimError(`${method} ${path} failed before a response: ${(err as Error).message}`, true);
      }
    }
    const text = await r.text();
    if (r.status >= 400) throw new SimError(`${method} ${path} -> ${r.status} ${text}`);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  // ---- discovery (costly: once per level load) --------------------------------
  listParkingSpots = () => this.request<SimParkingSpot[]>("GET", "/list-parking-spots");
  listBarriers = () => this.request<SimBarrier[]>("GET", "/list-barriers");
  listLights = () => this.request<SimLight[]>("GET", "/list-lights");
  listExhaustFans = () => this.request<SimExhaustFan[]>("GET", "/list-exhaust-fans");
  listAlarms = () => this.request<SimAlarm[]>("GET", "/list-alarms");
  listZones = () => this.request<SimZone[]>("GET", "/list-zones");
  testWebhook = () => this.request<string>("GET", "/test");

  // ---- gates ------------------------------------------------------------------
  openGate = (n: string) => this.request<void>("POST", `/barrier-gates/${enc(n)}/open`);
  closeGate = (n: string) => this.request<void>("POST", `/barrier-gates/${enc(n)}/close`);
  repairGate = (n: string) => this.request<void>("POST", `/barrier-gates/${enc(n)}/repair`);

  // ---- lights -----------------------------------------------------------------
  lightOn = (n: string) => this.request<void>("POST", `/lights/${enc(n)}/on`);
  lightOff = (n: string) => this.request<void>("POST", `/lights/${enc(n)}/off`);
  lightGroupOn = (g: string) => this.request<void>("POST", `/lights/group/${enc(g)}/on`);
  lightGroupOff = (g: string) => this.request<void>("POST", `/lights/group/${enc(g)}/off`);

  // ---- exhaust fans -------------------------------------------------------------
  fanOn = (n: string) => this.request<void>("POST", `/exhaust-fans/${enc(n)}/on`);
  fanOff = (n: string) => this.request<void>("POST", `/exhaust-fans/${enc(n)}/off`);
  repairFan = (n: string) => this.request<void>("POST", `/exhaust-fans/${enc(n)}/repair`);

  // ---- parking spots ------------------------------------------------------------
  repairSpot = (n: string) => this.request<void>("POST", `/parking-spots/${enc(n)}/repair`);

  // ---- cars -----------------------------------------------------------------------
  /** destination: a parking spot name, "exit" (pay at exit), or "leavepark". */
  carGoto = (plate: string, destination: string) =>
    this.request<void>("POST", `/car/${enc(plate)}/goto/${enc(destination)}`);

  /** Issue the invoice. Exactly once, only while the car is at an exit spot. */
  carCharge = (plate: string, parkingCost: number, chargingCost = 0) =>
    this.request<void>("POST", `/car/${enc(plate)}/charge?parkingCost=${parkingCost}&chargingCost=${chargingCost}`);
}

const enc = encodeURIComponent;
