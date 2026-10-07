// @gaiadesk/sdk: drive GaiaDesk desks from TypeScript / Node.js: through GaiaDesk's hosted API
// (given an apiKey), a desk's own API (transport: 'local' on the desk, 'lan' to its LAN gateway), else through the native
// library (@gaiadesk/sdk-native) when it is installed, else through gaiadesk-cli.
export { GaiaDesk } from './client.js';
export type { GaiaDeskOptions, CallOptions, ExecOptions, StreamExecOptions, Forward } from './client.js';
export { DEFAULT_API_URL, API_FILE_LIMIT } from './api.js';
export type { ApiCallOptions, FetchLike, ResponseLike, HttpTransportName } from './api.js';
export { LOCAL_API_UNAVAILABLE, localApiDir, localPipeName, localSocketPath, localTokenPath, pipeUser } from './local.js';
export { FingerprintMismatchError, normalizeFingerprint } from './lan.js';
export { CliStream } from './proc.js';
export type { Chunk, Exit, Completed, OutputStream } from './proc.js';
export type { NativeModule, NativeClientLike, NativeClientOptions, NativeCallOptions, NativeOutputStream, NativeEvent, NativeForwardHandle, NativeScreenHandle } from './native.js';
export { McpClient, McpError, MCP_PROTOCOL_VERSION, GAIADESK_TOOLS, toolText, toolImage } from './mcp.js';
export type { McpTool, McpToolResult, McpContent, GaiaDeskToolName } from './mcp.js';
export {
  GaiaDeskError,
  CliNotFoundError,
  UsageError,
  RefusedError,
  UnreachableError,
  ConnectionLostError,
  OperationFailedError,
  ProtocolError,
  CommandError,
} from './errors.js';
export { errorEnvelope } from './errors.js';
export type { ErrorKind, ErrorEnvelope, ErrorDetails } from './errors.js';
export { parseVersionInfo } from './results.js';
export { parseExecEvent } from './exec-stream.js';
export type { RunShapeOptions, JobOptions, JobShell, TokenCreateOptions, ForwardSpec, McpServerOptions } from './args.js';
export { locateCli, npmCliBinary } from './locate.js';
export * from './types.js';
