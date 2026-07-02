import { ACCEPTED_IMAGE_TYPES, attachmentSrc } from '@/lib/imageAttachments';
import { clipText, compareHistory, historyItemId } from '@aasis21/helm-shared';
import * as B from '@/test/helpers/builders';

describe('shared history helpers', () => {
  it('mergeHistory dedups by turnIndex and role with incoming winning, then sorts ascending', () => {
    const existing = [B.historyItem(2, 'assistant', 'old assistant'), B.historyItem(1, 'user', 'old user')];
    const incoming = [B.historyItem(2, 'assistant', 'new assistant'), B.historyItem(2, 'user', 'new user')];

    expect(B.mergeHistory(existing, incoming)).toEqual([
      B.historyItem(1, 'user', 'old user'),
      B.historyItem(2, 'user', 'new user'),
      B.historyItem(2, 'assistant', 'new assistant'),
    ]);
  });

  it('compareHistory orders by turn index and user before assistant', () => {
    const user = B.historyItem(1, 'user', 'u');
    const assistant = B.historyItem(1, 'assistant', 'a');
    const later = B.historyItem(2, 'user', 'later');

    expect(compareHistory(user, assistant)).toBeLessThan(0);
    expect(compareHistory(assistant, later)).toBeLessThan(0);
    expect(compareHistory(later, user)).toBeGreaterThan(0);
  });

  it('clipText clips strings with an ellipsis and normalizes non-strings', () => {
    expect(clipText('abcdef', 3)).toBe('abc…');
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText(null as unknown as string, 3)).toBe('');
  });

  it('historyItemId is stable for turn index and role', () => {
    expect(historyItemId(B.historyItem(7, 'assistant', 'text'))).toBe('7:assistant');
  });
});

describe('shared message helpers', () => {
  it('factories stamp the (eventType, eventSubtype) pair that identifies each message', () => {
    const pair = (m: { eventType: string; eventSubtype: string }) => [m.eventType, m.eventSubtype];
    expect(pair(B.assistantDelta('x'))).toEqual([B.EVENT_TYPE.STREAM, B.SUBTYPE.STREAM.ASSISTANT_DELTA]);
    expect(pair(B.approvalRequest('a1', 'shell', {}, []))).toEqual([B.EVENT_TYPE.APPROVAL, B.SUBTYPE.APPROVAL.REQUEST]);
    expect(pair(B.approvalDecision('a1', 'allow'))).toEqual([B.EVENT_TYPE.DECISION, B.SUBTYPE.DECISION.APPROVAL_DECISION]);
    expect(pair(B.elicitationRequest('e1', 'q', 'form', { type: 'object', properties: {} }))).toEqual([
      B.EVENT_TYPE.ELICITATION,
      B.SUBTYPE.ELICITATION.REQUEST,
    ]);
    expect(pair(B.prompt('hi'))).toEqual([B.EVENT_TYPE.PROMPT, B.SUBTYPE.PROMPT.PROMPT]);
    expect(pair(B.modeChange('plan'))).toEqual([B.EVENT_TYPE.CONTROL, B.SUBTYPE.CONTROL.MODE]);
  });

  it('isValidEnvelope accepts real factory envelopes and rejects malformed shapes', () => {
    expect(B.isValidEnvelope(B.assistantMessage('ok'))).toBe(true);
    expect(B.isValidEnvelope({})).toBe(false);
    expect(B.isValidEnvelope(null)).toBe(false);
    // missing msg
    expect(B.isValidEnvelope({ eventType: 'stream', eventSubtype: 'assistant_message', ts: 1 })).toBe(false);
    // non-string type
    expect(B.isValidEnvelope({ eventType: 1, eventSubtype: 'x', ts: 1, msg: {} })).toBe(false);
  });
});

describe('image attachment pure exports', () => {
  it('exposes accepted MIME types and builds img data URLs', () => {
    expect(ACCEPTED_IMAGE_TYPES).toBe('image/png,image/jpeg,image/webp,image/gif,image/bmp');
    expect(attachmentSrc({ data: 'abc123', mimeType: 'image/jpeg', name: 'photo.jpg' })).toBe('data:image/jpeg;base64,abc123');
  });

  it('leaves fileToAttachment to browser/canvas integration coverage', () => {
    // fileToAttachment depends on Image/createImageBitmap plus canvas encoding, which jsdom does not implement faithfully.
    expect(ACCEPTED_IMAGE_TYPES).not.toContain('image/heic');
  });
});
