// Parsing for numeric settings from the environment.

// Kubernetes injects WAIMEA_PORT=tcp://<service ip>:<port> into pods when a Service is named "waimea".
// That value describes the Service, not this pod, so it's ignored rather than parsed.
export function portSetting(env, name, fallback, warn) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw) && Number(raw) < 65536) return Number(raw);
  warn(`ignoring ${name}=${env[name]}: not a port number, using ${fallback}`);
  return fallback;
}
