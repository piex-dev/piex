/**
 * Credential-like repository paths.
 *
 * Single source of truth for every place that must keep credentials away from
 * a reviewer provider: diff capture (tracked, staged, committed, untracked),
 * the reviewer filesystem guard, and reviewer tool result filtering.
 *
 * Matching is case-insensitive because `.ENV` is the same file as `.env` on
 * the case-insensitive filesystems most reviewers run on, and repositories
 * carry both spellings.
 */

const CREDENTIAL_FILE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(?:^|\/)\.env(?:\..+)?$/i, reason: "credentials" },
  {
    pattern: /(?:^|\/)\.(?:npmrc|pypirc|netrc|gemrc|yarnrc\.yml)$/i,
    reason: "credentials",
  },
  { pattern: /(?:^|\/)\.docker\/config\.json$/i, reason: "credentials" },
  {
    pattern: /(?:^|\/)\.(?:token|secret|password)$/i,
    reason: "credentials",
  },
  { pattern: /(?:^|\/)\.aws\/credentials$/i, reason: "credentials" },
  { pattern: /(?:^|\/)\.git-credentials$/i, reason: "credentials" },
  { pattern: /(?:^|\/)\.pgpass$/i, reason: "credentials" },
  { pattern: /(?:^|\/)\.htpasswd$/i, reason: "credentials" },
  { pattern: /(?:^|\/)\.dockercfg$/i, reason: "credentials" },
  { pattern: /(?:^|\/)\.kube\/config$/i, reason: "credentials" },
  {
    pattern:
      /(?:^|\/)[^/]*(?:credential|secret|token|password|passwd|service[-_]?account|api[-_]?key)[^/]*\.(?:json|ya?ml|toml|env|txt|csv)$/i,
    reason: "credentials",
  },
  { pattern: /\.(?:pem|p12|pfx|ppk|key)$/i, reason: "private key" },
  {
    pattern: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
    reason: "private key",
  },
];

/**
 * Template files describe variables, not values, and are commonly the only
 * change in a configuration patch. Keep them reviewable.
 */
const CREDENTIAL_TEMPLATE_PATTERN =
  /(?:^|\/)\.env\.(?:example|sample|template|dist)$/i;

/** Reason a repository-relative path is credential-like, if any. */
export function credentialFileReason(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  if (CREDENTIAL_TEMPLATE_PATTERN.test(normalized)) return undefined;
  return CREDENTIAL_FILE_PATTERNS.find(({ pattern }) =>
    pattern.test(normalized),
  )?.reason;
}
