import type { EventEnvelope } from '@aasis21/weft-shared';
import { envelopeReceived } from './sessionsSlice';

export function routeEnvelope(id: string, envelope: EventEnvelope) {
  return envelopeReceived({ id, envelope });
}
