### Fixes

- feishu-app: the daemon is attachable again. The status-cards change added `streaming.enabled` to the daemon-side configuration fingerprint (`chat-daemon-cli.ts`) but not to the control-plane copy (`chat-daemon-control.ts`), so every daemon wrote a state identity the control plane computed differently: `daemon status` reported `stale` forever, `stop`/`restart` were refused as unauthorized, and `ensure` killed each daemon it spawned after the attach poll timed out. The control plane now hashes the same seven fields, so existing state records match without migration.
