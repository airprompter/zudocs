/** A short, readable path from an AirPrompter release to a Zudocs reply. */
export interface IntegrationStep {
  title: string;
  detail: string;
}

export function IntegrationFlow({ steps, label }: { steps: readonly IntegrationStep[]; label: string }) {
  return (
    <ol className="integration-flow" aria-label={label}>
      {steps.map((step, index) => (
        <li key={`${index}-${step.title}`}>
          <span className="flow-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <div><strong>{step.title}</strong><span>{step.detail}</span></div>
        </li>
      ))}
    </ol>
  );
}
