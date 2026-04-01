interface WizardPanelProps {
  title: string;
  steps: string[];
  currentStep: number;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

function StepDot({ index, currentStep }: { index: number; currentStep: number }) {
  const cls = index < currentStep ? "completed" : index === currentStep ? "active" : "";
  return <div className={`wizard-step-dot ${cls}`}>{index + 1}</div>;
}

function StepLine({ index, currentStep }: { index: number; currentStep: number }) {
  return <div className={`wizard-step-line ${index < currentStep ? "completed" : ""}`} />;
}

export function WizardPanel({
  title,
  steps,
  currentStep,
  onClose,
  children,
  footer,
}: WizardPanelProps) {
  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="wizard-panel" onClick={(e) => e.stopPropagation()}>
        <div className="wizard-header">
          <h2>{title}</h2>
          <button className="wizard-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="wizard-steps">
          {steps.map((_, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <StepLine index={i - 1} currentStep={currentStep} />}
              <StepDot index={i} currentStep={currentStep} />
            </span>
          ))}
        </div>
        <div
          style={{
            padding: "0 20px",
            fontSize: 11,
            color: "var(--text-muted)",
            textAlign: "center",
          }}
        >
          {steps[currentStep]}
        </div>
        <div className="wizard-content">{children}</div>
        {footer && <div className="wizard-footer">{footer}</div>}
      </div>
    </div>
  );
}
