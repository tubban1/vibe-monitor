// Shared, data-minimizing installation error categorization for the one Vibe Monitor client.
// Values are from an explicit allowlist; never persist raw exception messages.
const SAFE_CODES = new Set([
  "activation_code_required", "invalid_invite", "device_owned_by_other_tester",
  "cloud_preflight_failed", "credential_preflight_failed", "runtime_npm_missing",
  "runtime_install_verification_failed", "install_failed", "network_error",
  "permission_error", "configuration_error", "runtime_error", "cancelled",
  "node_download_failed", "node_checksum_mismatch", "unsupported_platform",
  "telemetry_required", "dns_failure", "tcp_timeout", "tls_failure", "tls_untrusted_ca", "https_timeout",
  "gateway_unreachable", "invalid_cloud_identity", "http_error"
]);

export function safeInstallError(error) {
  if (error?.installPhase === "cloud_preflight" && SAFE_CODES.has(error?.networkCategory))
    return error.networkCategory;
  const raw = String(error?.message || "");
  if (SAFE_CODES.has(raw)) return raw;
  const head = raw.split(":")[0];
  if (SAFE_CODES.has(head)) return head;
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission_error";
  if (error?.code === "ENOTFOUND" || error?.code === "ETIMEDOUT" || error?.code === "ECONNREFUSED") return "network_error";
  if (error?.installPhase === "cloud_preflight") return SAFE_CODES.has(error?.networkCategory) ? error.networkCategory : "cloud_preflight_failed";
  if (error?.installPhase === "activation") return "invalid_invite";
  return "install_failed";
}

export function isSafeInstallCode(value) { return SAFE_CODES.has(value); }
