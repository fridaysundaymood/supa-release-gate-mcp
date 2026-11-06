import { join } from 'node:path';
import type { ReleaseConfig } from './config.js';
import type { Json, Plan, Provider } from './gate.js';
import {
  createCloudflareGateProvider,
  createGcpGateProvider,
} from './providers/cloud-gate.js';
import {
  type PlayOperation,
  playBundleDigest,
  playDryRun,
  playExecute,
  playInspect,
  playReconcile,
  playVerify,
} from './providers/play.js';
import { createSupabaseProvider } from './providers/supabase.js';

export function resolveProvider(config: ReleaseConfig, plan: Plan): Provider {
  const options = config.providers?.[plan.provider];
  if (!options) throw new Error(`Provider not configured: ${plan.provider}`);
  if (plan.provider === 'supabase') {
    if (!options.projectRef || !options.workdir)
      throw new Error('Supabase projectRef and workdir are required');
    return createSupabaseProvider(
      {
        projectRef: options.projectRef,
        workdir: options.workdir,
        cli: options.cli,
        local: options.local === 'true',
        snapshotKeyFile: join(config.directory, 'supabase-snapshot.key'),
      },
      plan.target,
      config.supabaseChecks,
    );
  }
  if (plan.provider === 'play') {
    const accessToken =
      options.accessTokenEnv && process.env[options.accessTokenEnv];
    if (!options.packageName || !accessToken)
      throw new Error('Play packageName and accessTokenEnv are required');
    if (plan.target !== options.packageName)
      throw new Error('Play target does not match configured package');
    const settings = {
      packageName: options.packageName,
      accessToken,
    };
    const operation = plan.args as unknown as PlayOperation;
    return {
      inspect: async () => ({
        state: (await playInspect(settings)) as unknown as Json,
        bundleDigest: await playBundleDigest(operation),
      }),
      dryRun: async () =>
        (await playDryRun(settings, operation)) as unknown as Json,
      execute: async () =>
        (await playExecute(settings, operation)) as unknown as Json,
      verify: async () => await playVerify(settings, operation),
      reconcile: async () => ({
        status:
          (await playReconcile(settings, operation)) === 'observed'
            ? 'succeeded'
            : 'unresolved',
        evidence: null,
      }),
    };
  }
  if (plan.provider === 'cloudflare' || plan.provider === 'gcp') {
    const token = options.accessTokenEnv && process.env[options.accessTokenEnv];
    if (!token)
      throw new Error(
        'Provider accessTokenEnv must name a populated environment variable',
      );
    if (plan.provider === 'gcp') return createGcpGateProvider({ token });
    if (!options.accountId) throw new Error('Cloudflare accountId is required');
    return createCloudflareGateProvider({
      token,
      accountId: options.accountId,
      zoneId: options.zoneId,
      wrangler: options.wrangler,
    });
  }
  throw new Error(`Unsupported provider: ${plan.provider}`);
}
