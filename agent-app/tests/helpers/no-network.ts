import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

export class NetworkAccessDeniedError extends Error {
  readonly code = "TEST_NETWORK_DENIED";

  constructor() {
    super("Unit tests must explicitly mock network access.");
    this.name = "NetworkAccessDeniedError";
  }
}

function denyNetwork(): never {
  // Do not include URLs, request bodies, headers or credentials in test errors.
  throw new NetworkAccessDeniedError();
}

export function installUnitTestNetworkBoundary() {
  // Install the baseline directly: vi.unstubAllGlobals()/restoreAllMocks() must
  // restore this denial, never an original provider-capable fetch or request.
  // Individual tests can still spy/stub the owning API with explicit fixtures.
  globalThis.fetch = async () => denyNetwork();
  Object.assign(http, { get: denyNetwork, request: denyNetwork });
  Object.assign(https, { get: denyNetwork, request: denyNetwork });
  Object.assign(net, { connect: denyNetwork, createConnection: denyNetwork });
  Object.assign(tls, { connect: denyNetwork });
  Object.defineProperty(net.Socket.prototype, "connect", {
    configurable: true,
    writable: true,
    value: denyNetwork,
  });
  syncBuiltinESMExports();
}

// This is a unit-test-process boundary, not an OS sandbox for spawned programs.
