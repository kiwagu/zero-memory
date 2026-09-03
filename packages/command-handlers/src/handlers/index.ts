import { CloseLoopCommandHandler } from './close-loop.command-handler.js';
import { DescribeScopeCommandHandler } from './describe-scope.command-handler.js';
import { HardDeleteAccountCommandHandler } from './delete-account.command-handler.js';
import { ExportMemoriesCommandHandler } from './export-memories.command-handler.js';
import { ForgetMemoryCommandHandler } from './forget-memory.command-handler.js';
import { ImportMemoryCommandHandler } from './import-memory.command-handler.js';
import { IngestConversationCommandHandler } from './ingest-conversation.command-handler.js';
import { LinkCommandHandler } from './link.command-handler.js';
import { RememberCommandHandler } from './remember.command-handler.js';
import { MoveMemoriesCommandHandler } from './move-memories.command-handler.js';
import { ShareMemoryCommandHandler } from './share-memory.command-handler.js';

export const commandHandlers = [
  CloseLoopCommandHandler,
  DescribeScopeCommandHandler,
  HardDeleteAccountCommandHandler,
  ExportMemoriesCommandHandler,
  ForgetMemoryCommandHandler,
  ImportMemoryCommandHandler,
  IngestConversationCommandHandler,
  LinkCommandHandler,
  RememberCommandHandler,
  MoveMemoriesCommandHandler,
  ShareMemoryCommandHandler,
];

export * from './close-loop.command-handler.js';
export * from './describe-scope.command-handler.js';
export * from './delete-account.command-handler.js';
export * from './export-memories.command-handler.js';
export * from './forget-memory.command-handler.js';
export * from './import-memory.command-handler.js';
export * from './ingest-conversation.command-handler.js';
export * from './link.command-handler.js';
export * from './remember.command-handler.js';
export * from './move-memories.command-handler.js';
export * from './share-memory.command-handler.js';
