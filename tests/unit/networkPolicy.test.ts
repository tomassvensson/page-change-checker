import { describe, expect, it } from 'vitest';

import { isPrivateOrReservedIp, NetworkGuard } from '../../src/core/networkPolicy.js';

describe('NetworkGuard', () => {
  it.each([
    'http://127.0.0.1/admin',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://metadata.google.internal/'
  ])('blocks private and metadata destinations: %s', async (url) => {
    const guard = new NetworkGuard({ allowPrivateAddresses: false, allowedHosts: [] });
    await expect(guard.assertUrlAllowed(url)).rejects.toThrow('Network policy');
  });

  it('allows public unicast IPs and explicit private-address opt-in', async () => {
    const strict = new NetworkGuard({ allowPrivateAddresses: false, allowedHosts: [] });
    await expect(strict.assertUrlAllowed('https://8.8.8.8/')).resolves.toBeUndefined();

    const local = new NetworkGuard({ allowPrivateAddresses: true, allowedHosts: [] });
    await expect(local.assertUrlAllowed('http://127.0.0.1/')).resolves.toBeUndefined();
  });

  it('supports exact and wildcard host allowlists', async () => {
    const guard = new NetworkGuard({
      allowPrivateAddresses: false,
      allowedHosts: ['localhost', '*.internal.example']
    });
    await expect(guard.assertUrlAllowed('http://localhost/')).resolves.toBeUndefined();
    await expect(
      guard.assertUrlAllowed('https://service.internal.example/')
    ).resolves.toBeUndefined();
  });

  it('rejects unsafe protocols and embedded credentials', async () => {
    const guard = new NetworkGuard({ allowPrivateAddresses: true, allowedHosts: [] });
    await expect(guard.assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(
      'Blocked URL protocol'
    );
    await expect(guard.assertUrlAllowed('https://user:password@example.com/')).rejects.toThrow(
      'embedded credentials'
    );
    await expect(guard.assertUrlAllowed('data:text/plain,ok', true)).resolves.toBeUndefined();
  });
});

describe('isPrivateOrReservedIp', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.0.1',
    '198.51.100.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1'
  ])('classifies %s as non-public', (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'classifies %s as public unicast',
    (address) => {
      expect(isPrivateOrReservedIp(address)).toBe(false);
    }
  );
});
