const SECRET_BASENAMES = [
  /^\.env(?!.*example$).*/, /\.pem$/, /\.key$/, /^id_[a-z0-9]+$/,
  /^\.git-credentials$/, /^credentials.*$/, /\.token$/,
];
const SECRET_SEGMENTS = new Set([".ssh", ".aws", ".azure", "secrets", "gcloud"]);

export function isSecretPath(relativePosixPath: string): boolean {
  const segments = relativePosixPath.split("/");
  const base = segments[segments.length - 1];
  if (SECRET_BASENAMES.some((re) => re.test(base))) return true;
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const joined = segments.join("/");
  return joined.includes(".config/gcloud");
}
