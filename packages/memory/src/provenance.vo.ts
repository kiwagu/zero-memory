import type { MemoryAuthorKind, UserId } from '@workspace/contracts';
import { ValueObject } from '@workspace/domain';

export interface ProvenanceProps {
  ownerId: UserId;
  authorKind: MemoryAuthorKind;
  agentName: string | null;
  source: Record<string, unknown> | null;
}

/**
 * Where a memory came from: its owner, whether a human or an agent wrote it,
 * which agent, and an optional free-form source descriptor.
 */
export class Provenance extends ValueObject<ProvenanceProps> {
  static create(props: {
    ownerId: UserId;
    authorKind?: MemoryAuthorKind;
    agentName?: string | null;
    source?: Record<string, unknown> | null;
  }): Provenance {
    return new Provenance({
      ownerId: props.ownerId,
      authorKind: props.authorKind ?? 'agent',
      agentName: props.agentName ?? null,
      source: props.source ?? null,
    });
  }

  get ownerId(): UserId {
    return this.props.ownerId;
  }

  get authorKind(): MemoryAuthorKind {
    return this.props.authorKind;
  }

  get agentName(): string | null {
    return this.props.agentName;
  }

  get source(): Record<string, unknown> | null {
    return this.props.source;
  }
}
