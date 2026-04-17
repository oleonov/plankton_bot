import { useFamilyAction } from "../api/hooks.ts";
import { ConfirmAction } from "./ConfirmAction.tsx";

export function FamilyActions({ familyId, enabled }: { familyId: string; enabled: boolean }) {
  const enable = useFamilyAction(familyId, "enable");
  const disable = useFamilyAction(familyId, "disable");

  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {enabled ? (
        <ConfirmAction
          label="Disable"
          confirmText={`Disable ${familyId}?`}
          variant="danger"
          showReason
          onConfirm={(r) => disable.mutate(r)}
          isPending={disable.isPending}
        />
      ) : (
        <ConfirmAction
          label="Enable"
          confirmText={`Enable ${familyId}?`}
          variant="success"
          showReason
          onConfirm={(r) => enable.mutate(r)}
          isPending={enable.isPending}
        />
      )}
    </span>
  );
}
