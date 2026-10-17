/**
 * VS Code surface exports.
 *
 * Runtime events are interpreted by the owning BackendPipeline and emitted as
 * SSP parts. The VS Code surfaces consume that shared Pipeline/SSP flow
 * instead of owning protocol-specific rendering logic.
 *
 * @module
 */
export * from './capabilities';
export * from './stable-participant';
export * from './experimental-session';
export * from './language-model-provider';
