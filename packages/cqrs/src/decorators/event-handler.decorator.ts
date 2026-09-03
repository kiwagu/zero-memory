import 'reflect-metadata';

import type { BaseEvent } from '@workspace/domain';
import { nanoid } from 'nanoid';

import type { Class } from '../types.js';
import { EVENT_HANDLER_METADATA, EVENT_METADATA } from './constants.js';

/**
 * Marks a class as the handler of the given event type.
 */
export const eventHandler = (event: Class<BaseEvent>): ClassDecorator => {
  return (target: object) => {
    if (!Reflect.hasOwnMetadata(EVENT_METADATA, event)) {
      Reflect.defineMetadata(EVENT_METADATA, { id: nanoid() }, event);
    }
    Reflect.defineMetadata(EVENT_HANDLER_METADATA, event, target);
  };
};
