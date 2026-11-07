import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createResult,
  newRunId,
  type Result,
  writeArtifactIndex,
} from '@android-kit/schema';
import { promptApproval } from './approver.js';
import type { ReleaseConfig } from './config.js';
import { type DoctorResult, doctor } from './doctor.js';
import { externalExecute } from './executor.js';
import {
  type Approval,
  Gate,
  hashJson,
  type Plan,
  type Provider,
  renderChangelog,
} from './gate.js';

export type ProviderResolver = (plan: Plan) => Promise<Provider> | Provider;
export type Operation =
  | 'plan'
  | 'dry-run'
  | 'approval-status'
  | 'execute'
  | 'verify'
  | 'recover'
  | 'ledger-list'
  | 'ledger-render'
  | 'status'
  | 'doctor';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
};
const hashArg = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Invalid plan hash');
  return value;
};

export class ReleaseInterfaces {
  readonly gate: Gate;
  constructor(
    readonly config: ReleaseConfig,
    readonly providers: ProviderResolver,
  ) {
    this.gate = new Gate({
      directory: config.directory,
      trustedPublicKeys: config.trustedPublicKeys,
      authorizePlan: (plan) =>
        config.policies.some(
          (rule) =>
            rule.provider === plan.provider &&
            rule.target === plan.target &&
            rule.operation === plan.operation &&
            rule.id === plan.policy?.id &&
            rule.mode === plan.policy.mode,
        ),
    });
  }
  private async planFor(hash: string): Promise<Plan> {
    const entry = (await this.gate.ledger()).find(
      (e) => e.type === 'plan' && object(e.data).hash === hash,
    );
    if (!entry) throw new Error('Unknown plan');
    return object(entry.data).plan as Plan;
  }
  private approvalPath(hash: string): string {
    return join(this.config.approvalDirectory, `${hash}.json`);
  }
  async approve(
    hash: string,
    keyDirectory: string,
    expiresAt: string,
  ): Promise<Approval> {
    hash = hashArg(hash);
    const plan = await this.planFor(hash);
    const entries = await this.gate.ledger();
    const dry = [...entries]
      .reverse()
      .find((e) => e.type === 'dry-run' && object(e.data).planHash === hash);
    if (!dry) throw new Error('Dry run required');
    if (
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now()
    )
      throw new Error('Invalid approval expiry');
    const payload = {
      planHash: hash,
      target: plan.target,
      evidenceHash: String(object(dry.data).evidenceHash),
      policyId: plan.policy.id,
      expiresAt,
      nonce: randomBytes(32).toString('hex'),
    };
    const approval = await promptApproval(keyDirectory, payload);
    if (!this.config.trustedPublicKeys[approval.keyId])
      throw new Error('Approval key is not trusted by the gate');
    await mkdir(this.config.approvalDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(this.approvalPath(hash), JSON.stringify(approval), {
      mode: 0o600,
    });
    return approval;
  }
  async invoke(
    operation: Operation,
    input: Record<string, unknown> = {},
  ): Promise<Result> {
    const startedAt = new Date();
    const run_id = newRunId();
    try {
      await writeArtifactIndex(
        this.config.projectRoot ?? process.cwd(),
        run_id,
        'release',
        [],
      );
      let data: unknown;
      if (operation === 'plan')
        data = { planHash: await this.gate.plan(object(input.plan) as Plan) };
      else if (operation === 'ledger-list') data = await this.gate.ledger();
      else if (operation === 'ledger-render')
        data = renderChangelog(await this.gate.ledger());
      else if (operation === 'status') {
        const entries = await this.gate.ledger();
        const pending = new Map<
          string,
          {
            planHash: string;
            target: string;
            status: string;
            expiresAt: string | null;
          }
        >();
        for (const entry of entries) {
          const record = object(entry.data);
          if (entry.type === 'plan') {
            const plan = object(record.plan);
            const planHash = String(record.hash);
            pending.set(planHash, {
              planHash,
              target: String(plan.target),
              status: 'planned',
              expiresAt:
                typeof plan.expiresAt === 'string' ? plan.expiresAt : null,
            });
          } else if (entry.type === 'dry-run') {
            const plan = pending.get(String(record.planHash));
            if (plan) plan.status = 'awaiting-approval';
          } else if (entry.type === 'intent') {
            pending.delete(String(record.planHash));
          }
        }
        for (const plan of pending.values()) {
          try {
            const approval = JSON.parse(
              await readFile(this.approvalPath(plan.planHash), 'utf8'),
            ) as Approval;
            plan.expiresAt = approval.expiresAt;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        data = {
          ledgerEntries: entries.length,
          pendingPlans: [...pending.values()],
        };
      } else if (operation === 'doctor') data = await doctor(this.config);
      else {
        const hash = hashArg(input.planHash);
        const plan = await this.planFor(hash);
        if (operation === 'approval-status') {
          try {
            const approval = JSON.parse(
              await readFile(this.approvalPath(hash), 'utf8'),
            ) as Approval;
            const used = (await this.gate.ledger()).some(
              (e) =>
                e.type === 'intent' && object(e.data).nonce === approval.nonce,
            );
            data = {
              exists: true,
              expired: Date.parse(approval.expiresAt) <= Date.now(),
              used,
              keyId: approval.keyId,
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            data = { exists: false };
          }
        } else {
          const provider = await this.providers(plan);
          if (operation === 'dry-run')
            data = await this.gate.dryRun(hash, provider);
          else if (operation === 'verify') data = await provider.verify(plan);
          else if (operation === 'recover') {
            await this.gate.recover(plan.provider, plan.target, provider);
            const records = (await this.gate.ledger()).filter(
              (entry) =>
                ['unresolved', 'reconciled', 'outcome'].includes(entry.type) &&
                object(entry.data).targetKey ===
                  hashJson([plan.provider, plan.target]),
            );
            const latest = new Map(
              records.map((entry) => [object(entry.data).intentId, entry]),
            );
            if (
              [...latest.values()].some((entry) => entry.type === 'unresolved')
            )
              throw new Error(
                'Recovery unresolved; human investigation is required before further writes',
              );
            data = { records };
          } else if (operation === 'execute') {
            const approval = JSON.parse(
              await readFile(this.approvalPath(hash), 'utf8'),
            ) as Approval;
            const executable = this.config.externalExecutor;
            const selected = executable
              ? {
                  ...provider,
                  execute: (value: Plan) =>
                    externalExecute(executable, value, approval),
                }
              : provider;
            data = await this.gate.execute(hash, approval, selected);
          } else throw new Error('Unknown operation');
        }
      }
      const verification =
        operation === 'verify'
          ? data
          : operation === 'execute'
            ? object(data).verification
            : undefined;
      const failed =
        verification === false ||
        (verification !== null &&
          typeof verification === 'object' &&
          !Array.isArray(verification) &&
          ['matched', 'verified', 'passed', 'observed'].some(
            (key) => (verification as Record<string, unknown>)[key] === false,
          ));
      const missing =
        operation === 'doctor' &&
        (data as DoctorResult).checks.some((check) => !check.ok);
      return createResult({
        tool: 'release',
        operation,
        run_id,
        status: missing ? 'blocked' : failed ? 'fail' : 'pass',
        summary: missing
          ? 'Prerequisites missing or incompatible'
          : failed
            ? 'Verification failed'
            : `${operation} completed`,
        evidence: [data],
        artifacts: [],
        startedAt,
      });
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const status = /unsupported/i.test(summary)
        ? 'unsupported'
        : /required|invalid|unknown|mismatch|expired|approval|refus|blocked|changed|unresolved/i.test(
              summary,
            )
          ? 'blocked'
          : 'error';
      return createResult({
        tool: 'release',
        operation,
        run_id,
        status,
        classification: status === 'error' ? 'environment' : 'config',
        summary,
        evidence: [],
        artifacts: [],
        startedAt,
      });
    }
  }
}
