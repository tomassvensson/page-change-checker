import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkSonarCloudAuth(
  token: string | undefined,
  request: typeof fetch = fetch
) {
  if (!token?.trim())
    throw new Error(
      'A SonarCloud token is required. Configure SONAR_CLOUD_TOKEN locally and the repository SONAR_TOKEN secret; do not use a NAS token.'
    );
  const headers = { Authorization: `Bearer ${token.trim()}` };
  const auth = await request('https://sonarcloud.io/api/authentication/validate', {
    headers,
    signal: AbortSignal.timeout(15000)
  });
  if (!auth.ok)
    throw new Error(
      `SonarCloud authentication failed (HTTP ${auth.status}); token and response content withheld`
    );
  const result: unknown = await auth.json();
  if (!result || typeof result !== 'object' || !('valid' in result) || result.valid !== true)
    throw new Error('SonarCloud token is invalid; token and response content withheld');
  const provisioning = await request(
    'https://api.sonarcloud.io/analysis/jres?os=linux&arch=x86_64',
    { headers, signal: AbortSignal.timeout(15000) }
  );
  if (!provisioning.ok)
    throw new Error(
      `SonarCloud analysis preflight failed (HTTP ${provisioning.status}); check token permissions`
    );
  console.log(
    'SonarCloud authentication and analysis provisioning passed; the actual scan remains required.'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkSonarCloudAuth(process.env.SONAR_CLOUD_TOKEN);
