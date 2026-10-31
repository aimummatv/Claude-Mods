// Masks secrets before any text is written to disk.

const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, label: 'sk-key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: 'github-token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: 'github-token' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, label: 'slack-token' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, label: 'google-key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key' },
  { re: /\bshp(?:at|ca|pa|ss)_[A-Fa-f0-9]{20,}/g, label: 'shopify-token' },
  { re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, label: 'stripe-key' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, label: 'bearer' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'private-key' },
  {
    re: /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*["']?)([^\s"']{8,})/gi,
    label: 'assigned-secret',
  },
]

export const redactSecrets = (text: string): string => {
  let out = text
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, (match: string, prefix?: unknown) =>
      label === 'assigned-secret' && typeof prefix === 'string' ? `${prefix}[REDACTED]` : `[REDACTED:${label}]`,
    )
  }
  return out
}
