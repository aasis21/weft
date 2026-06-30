import type { ApprovalRequest } from '@aasis21/helm-shared';

interface ApprovalCardProps {
  request: ApprovalRequest;
  onApprove(requestId: string, optionId: string): Promise<void>;
}

export function ApprovalCard({ request, onApprove }: ApprovalCardProps): JSX.Element {
  return (
    <section className="approval-card">
      <p className="eyebrow">Native Copilot permission</p>
      <h2>{request.toolName}</h2>
      {request.toolArgs ? <pre>{JSON.stringify(request.toolArgs, null, 2)}</pre> : null}
      <div className="approval-options">
        {request.options.map((option) => (
          <button
            key={option.id}
            className={option.id.includes('deny') ? 'danger-action' : 'primary-action compact'}
            type="button"
            onClick={() => void onApprove(request.requestId, option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
