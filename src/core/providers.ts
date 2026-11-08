import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
        secretEnvAllowlist: config.policies
          .filter(
            (rule) =>
              rule.provider === plan.provider &&
              rule.target === plan.target &&
              rule.operation === plan.operation &&
              rule.id === plan.policy.id &&
              rule.mode === plan.policy.mode,
          )
          .reduce<string[] | undefined>(
            (allowed, rule) =>
              allowed === undefined
                ? [...(rule.secretEnvAllowlist ?? [])]
                : allowed.filter((name) =>
                    rule.secretEnvAllowlist?.includes(name),
                  ),
            undefined,
          ),
        credentialEnvDenylist: [
          ...Object.values(config.providers ?? {}).flatMap((provider) =>
            provider.accessTokenEnv ? [provider.accessTokenEnv] : [],
          ),
          ...Object.values(config.supabaseChecks ?? {}).map(
            (check) => check.connectionEnv,
          ),
        ],
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
    const safeOperation = async (): Promise<PlayOperation> => {
      if (!operation.bundlePath) return operation;
      const root = await realpath(config.projectRoot ?? process.cwd());
      const bundlePath = await realpath(resolve(root, operation.bundlePath));
      const path = relative(root, bundlePath);
      if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
        throw new Error('Play bundle is outside the project root');
      return { ...operation, bundlePath };
    };
    return {
      inspect: async () => {
        const input = await safeOperation();
        return {
          state: (await playInspect(settings)) as unknown as Json,
          bundleDigest: await playBundleDigest(input),
        };
      },
      dryRun: async () =>
        (await playDryRun(settings, await safeOperation())) as unknown as Json,
      execute: async (_plan, approved) => {
        const evidence = approved?.evidence;
        const state = approved?.state;
        if (
          !evidence ||
          typeof evidence !== 'object' ||
          Array.isArray(evidence) ||
          !state ||
          typeof state !== 'object' ||
          Array.isArray(state) ||
          !(
            typeof evidence.bundleSha256 === 'string' ||
            evidence.bundleSha256 === null
          ) ||
          state.bundleDigest !== evidence.bundleSha256
        )
          throw new Error('Approved Play bundle digest required');
        return (await playExecute(
          settings,
          await safeOperation(),
          evidence.bundleSha256,
        )) as unknown as Json;
      },
      verify: async () => await playVerify(settings, await safeOperation()),
      reconcile: async () => ({
        status:
          (await playReconcile(settings, await safeOperation())) === 'observed'
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
      pagesRoot: options.pagesRoot,
      projectRoot: config.projectRoot,
    });
  }
  throw new Error(`Unsupported provider: ${plan.provider}`);
}
