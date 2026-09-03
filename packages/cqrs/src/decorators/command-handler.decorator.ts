import 'reflect-metadata';

import type { Command } from '@workspace/domain';
import { nanoid } from 'nanoid';

import type { Class } from '../types.js';
import { COMMAND_HANDLER_METADATA, COMMAND_METADATA } from './constants.js';

/**
 * Marks a class as the handler of the given command type.
 */
export const commandHandler = (command: Class<Command>): ClassDecorator => {
  return (target: object) => {
    if (!Reflect.hasOwnMetadata(COMMAND_METADATA, command)) {
      Reflect.defineMetadata(COMMAND_METADATA, { id: nanoid() }, command);
    }
    Reflect.defineMetadata(COMMAND_HANDLER_METADATA, command, target);
  };
};
