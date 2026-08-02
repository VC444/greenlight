/**
 * Silences the AI SDK's warning logger.
 *
 * The warnings that actually fire on a run come from Stagehand's internals, not
 * from our own calls — its bundled ai@5 builds a togetherai-prefixed provider
 * without supportsStructuredOutputs ("responseFormat is not supported by this
 * model") and passes its system prompt inside `messages` ("System messages in
 * the prompt or messages fields can be a security risk"). Neither is reachable
 * from here: Stagehand owns those call sites, and we deliberately do not inject
 * a model across the ai@7/ai@5 boundary. So the only lever is the logger, and
 * left on it repeats both lines on every act/extract — dozens per PR, drowning
 * the run's real output.
 *
 * This is a global rather than a per-call option, which is what makes one
 * assignment cover both copies of the SDK in the tree: each reads
 * globalThis at log time.
 *
 * Import this first from an entry point, before anything that reaches a model.
 * GREENLIGHT_DEBUG=1 restores them, alongside the rest of the debug logging.
 */
if (process.env.GREENLIGHT_DEBUG !== "1") {
  globalThis.AI_SDK_LOG_WARNINGS = false;
}
