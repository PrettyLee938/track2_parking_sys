class SimulatorError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = 'SimulatorError';
    this.status = status;
    this.details = details;
  }
}

class SimulatorClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.baseUrl = config.simulatorBaseUrl;
    this.username = config.simulatorUsername;
    this.password = config.simulatorPassword;
    this.fetch = fetchImpl;
    this.token = null;
  }

  async login() {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: this.username, password: this.password }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new SimulatorError(`Cannot reach simulator at ${this.baseUrl}`, 503, error.message);
    }

    const body = await this.readResponse(response);
    if (!response.ok || !body?.token) {
      throw new SimulatorError('Simulator authentication failed', response.status || 502, body);
    }
    this.token = body.token;
    return this.token;
  }

  async request(path, options = {}, canRetry = true) {
    if (!this.token) await this.login();
    // The simulator closes idle keep-alive sockets, so a reused connection can be
    // reset just as we send. That is a transport failure, not a rejected request,
    // and retrying it immediately beats waiting for the next dispatch pass.
    const retryNetwork = options.retryNetwork === undefined
      ? (options.method || 'GET') === 'GET'
      : options.retryNetwork;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1${path}`, {
        method: options.method || 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs || 8000),
      });
    } catch (error) {
      if (retryNetwork && canRetry) {
        return this.request(path, { ...options, retryNetwork: false }, false);
      }
      throw new SimulatorError(
        `Simulator request failed: ${path} (${error.message})`,
        503,
        error.message,
      );
    }

    if (response.status === 401 && canRetry) {
      this.token = null;
      await this.login();
      return this.request(path, options, false);
    }

    const body = await this.readResponse(response);
    if (!response.ok) {
      throw new SimulatorError(
        `Simulator returned HTTP ${response.status} for ${path}`,
        response.status,
        body,
      );
    }
    return { status: response.status, body };
  }

  async readResponse(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async syncAll() {
    const routes = {
      parkingSpots: '/list-parking-spots',
      barriers: '/list-barriers',
      lights: '/list-lights',
      exhaustFans: '/list-exhaust-fans',
      alarms: '/list-alarms',
      zones: '/list-zones',
    };
    const entries = await Promise.all(
      Object.entries(routes).map(async ([key, path]) => [key, (await this.request(path)).body]),
    );
    return Object.fromEntries(entries);
  }

  openBarrier(name) {
    return this.post(`/barrier-gates/${this.segment(name)}/open`, true);
  }

  closeBarrier(name) {
    return this.post(`/barrier-gates/${this.segment(name)}/close`, true);
  }

  repairBarrier(name) {
    return this.post(`/barrier-gates/${this.segment(name)}/repair`);
  }

  setLight(name, on) {
    return this.post(`/lights/${this.segment(name)}/${on ? 'on' : 'off'}`);
  }

  setLightGroup(name, on) {
    return this.post(`/lights/group/${this.segment(name)}/${on ? 'on' : 'off'}`);
  }

  setExhaustFan(name, action) {
    return this.post(`/exhaust-fans/${this.segment(name)}/${this.segment(action)}`);
  }

  repairParkingSpot(name) {
    return this.post(`/parking-spots/${this.segment(name)}/repair`);
  }

  moveCar(plate, destination) {
    return this.post(`/car/${this.segment(plate)}/goto/${this.segment(destination)}`, true);
  }

  chargeCar(plate, parkingCost, chargingCost) {
    const query = new URLSearchParams({
      parkingCost: String(parkingCost),
      chargingCost: String(chargingCost),
    });
    return this.post(`/car/${this.segment(plate)}/charge?${query}`);
  }

  testWebhook() {
    return this.request('/test');
  }

  // retryNetwork must stay false for anything that is not safe to repeat,
  // such as charging a car, where a repeat would be a double charge.
  post(path, retryNetwork = false) {
    return this.request(path, { method: 'POST', retryNetwork });
  }

  segment(value) {
    return encodeURIComponent(String(value));
  }
}

module.exports = { SimulatorClient, SimulatorError };
