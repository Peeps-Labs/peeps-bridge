/**
 * `@peepsai/bridge/protocol`: the runner side of Peeps' agent bridge, with no
 * browser in it. See `session.ts`.
 */
export {
  BridgeRefusedError,
  LONG_POLL_SECONDS,
  MAX_TRANSPORT_ERRORS,
  runBridgeSession,
  type BridgeCall,
  type BridgeSessionOptions,
  type BridgeToolSpec,
  type CallOutcome,
  type SessionEnd,
  type SessionEndReason,
} from "./session.js";
