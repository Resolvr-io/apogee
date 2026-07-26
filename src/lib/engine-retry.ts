// Whether an engine send failed because nobody was listening yet, as opposed to
// the engine actually reporting an error.
//
// Chrome's offscreen `createDocument` resolves when the document EXISTS, which is
// earlier than when offscreen.ts has evaluated and registered its onMessage
// listener. A request sent inside that gap reaches no receiver. Distinguishing
// that from a real failure is what makes retrying safe: retrying a genuine engine
// error would double the work and hide the cause.
//
// Pure and dependency-free so it's unit-testable — background/index.ts registers
// listeners at module load and can't be imported under Node.

/** Chrome's wording when no listener is registered for a runtime message. */
const NO_RECEIVER = /receiving end does not exist|could not establish connection/i;

/** True when `err` is Chrome's "nobody was listening" rejection. */
export function isNoReceiverError(err: unknown): boolean {
  return NO_RECEIVER.test(err instanceof Error ? err.message : String(err));
}

/** True when a `sendMessage` outcome means "retry", i.e. the listener wasn't up.
 *  `undefined` is the resolve-shaped version of the same condition: Chrome
 *  resolves with no value when a message goes unanswered. An `{ok:false}` reply is
 *  a REAL engine error and must not retry. */
export function shouldRetryEngineSend(reply: unknown): boolean {
  return reply === undefined;
}
