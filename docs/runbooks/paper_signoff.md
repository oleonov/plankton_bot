# Paper Mode Signoff

Paper mode is no longer a supported runtime/operator profile.

Historical `paper` rows may remain in the control DB and tests may still use fake
gateways, but production startup, profile switching, and runtime-manager paths now
accept only `live-lite`.

Use `docs/runbooks/live_lite_preflight.md` and `docs/runbooks/live_lite_rollout.md`
for current operator procedures.
