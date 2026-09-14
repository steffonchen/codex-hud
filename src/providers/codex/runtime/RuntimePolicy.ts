export interface RuntimePolicy {
  prefer_managed: boolean;
  prefer_shared: boolean;
  allow_spawn: boolean;
  allow_external_attach: boolean;
  auto_reconnect: boolean;
  auto_start_managed: boolean;
}

export const defaultRuntimePolicy: Readonly<RuntimePolicy> = Object.freeze({ prefer_managed: true, prefer_shared: true,
  allow_spawn: true, allow_external_attach: true, auto_reconnect: true, auto_start_managed: false });
