import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import ipaddr from 'ipaddr.js';

import { NetworkPolicyError } from './errors.js';
import type { NetworkPolicyConfig } from './types.js';

const SAFE_NON_NETWORK_PROTOCOLS = new Set(['about:', 'blob:', 'data:']);
const BLOCKED_HOSTNAMES = new Set([
  'instance-data',
  'instance-data.ec2.internal',
  'metadata',
  'metadata.google.internal'
]);

export class NetworkGuard {
  private readonly cache = new Map<string, Promise<void>>();

  constructor(private readonly policy: NetworkPolicyConfig) {}

  assertUrlAllowed(rawUrl: string, allowNonNetworkProtocols = false): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return Promise.reject(new NetworkPolicyError('Blocked URL: invalid URL'));
    }

    if (allowNonNetworkProtocols && SAFE_NON_NETWORK_PROTOCOLS.has(url.protocol)) {
      return Promise.resolve();
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Promise.reject(
        new NetworkPolicyError(`Blocked URL protocol: ${url.protocol || '[missing]'}`)
      );
    }
    if (url.username || url.password) {
      return Promise.reject(new NetworkPolicyError('Blocked URL containing embedded credentials'));
    }

    return this.assertHostAllowed(url.hostname);
  }

  assertHostAllowed(rawHostname: string): Promise<void> {
    const hostname = normalizeHostname(rawHostname);
    if (!hostname) {
      return Promise.reject(new NetworkPolicyError('Blocked host: missing hostname'));
    }
    const cached = this.cache.get(hostname);
    if (cached) return cached;

    const check = this.checkHostname(hostname);
    this.cache.set(hostname, check);
    return check;
  }

  private async checkHostname(hostname: string): Promise<void> {
    if (hostMatchesAllowlist(hostname, this.policy.allowedHosts)) return;
    if (this.policy.allowPrivateAddresses) return;

    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      BLOCKED_HOSTNAMES.has(hostname)
    ) {
      throw new NetworkPolicyError(`Network policy blocked host ${hostname}`);
    }

    const ipVersion = isIP(hostname);
    let addresses: string[];
    try {
      addresses =
        ipVersion === 0
          ? await lookup(hostname, { all: true, verbatim: true }).then((rows) =>
              rows.map((row) => row.address)
            )
          : [hostname];
    } catch (error) {
      throw new NetworkPolicyError(`Network policy could not resolve host ${hostname}`, {
        cause: error
      });
    }

    if (addresses.length === 0) {
      throw new NetworkPolicyError(`Network policy could not resolve host ${hostname}`);
    }
    const blocked = addresses.find(isPrivateOrReservedIp);
    if (blocked) {
      throw new NetworkPolicyError(`Network policy blocked address ${blocked} for ${hostname}`);
    }
  }
}

export function isPrivateOrReservedIp(rawAddress: string): boolean {
  const address = normalizeHostname(rawAddress.split('%')[0] ?? rawAddress);
  if (isIP(address) === 0) return true;
  try {
    return ipaddr.process(address).range() !== 'unicast';
  } catch {
    return true;
  }
}

function hostMatchesAllowlist(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((entry) => {
    const candidate = normalizeHostname(entry);
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1);
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === candidate;
  });
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
}
