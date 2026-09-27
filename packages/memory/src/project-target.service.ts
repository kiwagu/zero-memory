import {
  boardTargetRequiredMessage,
  validationFailed,
  type Failure,
} from '@workspace/contracts';
import { inject, singleton } from '@workspace/di';
import { Err, Ok, type Result } from 'oxide.ts';

import { MemoryService } from './memory.service.js';
import {
  projectChoices,
  projectHintMissMessage,
} from './project-name.utils.js';
import { ScopeRoutingService } from './scope-routing.service.js';

/** How a call named the board its work is on. */
export interface BoardTargetInput {
  /** The board's scope, taken as given. */
  readonly scope?: string;
  /** A project name, repo root path or git remote naming the board. */
  readonly projectHint?: string;
  /** The conversation the call came from, for the session's project. */
  readonly thread?: string;
  /**
   * Whether a call naming no board goes to the session's project. True for
   * opening a card, the way a scope-less `remember` lands in the project.
   */
  readonly sessionDefault: boolean;
}

/**
 * Decides which project board a call means.
 *
 * Work found in one project often belongs on another's board, so a board can
 * be named the way a person would name the project — `zero-memory`, `ZM` —
 * and filing there never moves the conversation: the session stays where it
 * was, and so do its later writes.
 */
@singleton()
export class ProjectTargetService {
  constructor(
    @inject(ScopeRoutingService)
    private readonly routing: ScopeRoutingService,
    @inject(MemoryService)
    private readonly memory: MemoryService
  ) {}

  /**
   * The board's scope: an explicit `scope`, else the project the hint names,
   * else — when `sessionDefault` allows — the session's project. Null when
   * nothing named a board and no default applies. A hint that names no
   * project, or a card with nowhere to go, is refused with the caller's
   * projects to pick from.
   */
  async resolveBoard(
    input: BoardTargetInput
  ): Promise<Result<string | null, Failure>> {
    if (input.scope) {
      return Ok(input.scope);
    }
    if (input.projectHint) {
      const target = await this.routing.resolveProjectTarget(input.projectHint);
      if (target.isErr()) {
        return Err(
          validationFailed(
            projectHintMissMessage(input.projectHint, target.unwrapErr(), {
              portableLayers: false,
            })
          )
        );
      }
      return Ok(target.unwrap().path);
    }
    if (!input.sessionDefault) {
      return Ok(null);
    }
    const session = await this.memory.sessionProjectScope(input.thread);
    if (session) {
      return Ok(session);
    }
    return Err(
      validationFailed(
        boardTargetRequiredMessage(
          projectChoices(await this.routing.listProjects())
        )
      )
    );
  }
}
