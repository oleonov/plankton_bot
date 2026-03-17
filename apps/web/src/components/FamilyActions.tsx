import { useFamilyAction } from "../api/hooks.ts";
import { ConfirmAction } from "./ConfirmAction.tsx";

export function FamilyActions({ familyId, mode }: { familyId: string; mode: string }) {
  const quarantine = useFamilyAction(familyId, "quarantine");
  const reduceOnly = useFamilyAction(familyId, "reduce-only");
  const activate = useFamilyAction(familyId, "activate");

  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {mode === "active" && (
        <>
          <ConfirmAction label="R/O" confirmText={`Reduce-only ${familyId}?`} variant="danger" showReason onConfirm={(r) => reduceOnly.mutate(r)} isPending={reduceOnly.isPending} />
          <ConfirmAction label="Q" confirmText={`Quarantine ${familyId}?`} variant="danger" showReason onConfirm={(r) => quarantine.mutate(r)} isPending={quarantine.isPending} />
        </>
      )}
      {mode === "quarantine" && (
        <ConfirmAction label="Activate" confirmText={`Activate ${familyId}?`} variant="success" showReason onConfirm={(r) => activate.mutate(r)} isPending={activate.isPending} />
      )}
      {mode === "reduce-only" && (
        <>
          <ConfirmAction label="Activate" confirmText={`Activate ${familyId}?`} variant="success" showReason onConfirm={(r) => activate.mutate(r)} isPending={activate.isPending} />
          <ConfirmAction label="Q" confirmText={`Quarantine ${familyId}?`} variant="danger" showReason onConfirm={(r) => quarantine.mutate(r)} isPending={quarantine.isPending} />
        </>
      )}
    </span>
  );
}
