import 'reflect-metadata';

import type { Query } from '@workspace/domain';
import { nanoid } from 'nanoid';

import type { Class } from '../types.js';
import { QUERY_HANDLER_METADATA, QUERY_METADATA } from './constants.js';

/**
 * Marks a class as the handler of the given query type.
 */
export const queryHandler = (query: Class<Query>): ClassDecorator => {
  return (target: object) => {
    if (!Reflect.hasOwnMetadata(QUERY_METADATA, query)) {
      Reflect.defineMetadata(QUERY_METADATA, { id: nanoid() }, query);
    }
    Reflect.defineMetadata(QUERY_HANDLER_METADATA, query, target);
  };
};
