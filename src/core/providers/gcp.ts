export type GcpAuth = { token: string; fetch?: typeof fetch };
export type IamBinding = {
  role: string;
  members?: string[];
  condition?: {
    title?: string;
    description?: string;
    expression?: string;
    location?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type IamPolicy = {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
  auditConfigs?: unknown[];
  [key: string]: unknown;
};

export async function readIamPolicy(
  auth: GcpAuth,
  projectId: string,
): Promise<IamPolicy> {
  const response = await (auth.fetch ?? fetch)(
    `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}:getIamPolicy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
    },
  );
  const body = (await response.json()) as IamPolicy & {
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      `GCP IAM API failed (${response.status}): ${body.error?.message ?? 'unknown error'}`,
    );
  if (
    !body ||
    typeof body !== 'object' ||
    (body.bindings !== undefined && !Array.isArray(body.bindings))
  )
    throw new Error('Invalid GCP IAM policy response');
  return body;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Include full policies so version, etag, audit config, and conditional changes remain visible. */
export function diffIamPolicies(
  before: IamPolicy,
  after: IamPolicy,
): {
  before: IamPolicy;
  after: IamPolicy;
  added: IamBinding[];
  removed: IamBinding[];
  changed: boolean;
} {
  const normalize = (binding: IamBinding): IamBinding => ({
    ...binding,
    ...(binding.members ? { members: [...binding.members].sort() } : {}),
  });
  const oldBindings = (before.bindings ?? []).map(normalize);
  const newBindings = (after.bindings ?? []).map(normalize);
  const oldKeys = new Set(oldBindings.map(canonical));
  const newKeys = new Set(newBindings.map(canonical));
  const comparable = (policy: IamPolicy, bindings: IamBinding[]) => ({
    ...policy,
    bindings: [...bindings].sort((a, b) =>
      canonical(a).localeCompare(canonical(b)),
    ),
  });
  return {
    before,
    after,
    added: newBindings.filter((binding) => !oldKeys.has(canonical(binding))),
    removed: oldBindings.filter((binding) => !newKeys.has(canonical(binding))),
    changed:
      canonical(comparable(before, oldBindings)) !==
      canonical(comparable(after, newBindings)),
  };
}
