// @gaiadesk/sdk: drive GaiaDesk desks from TypeScript / Node.js through gaiadesk-cli.
export { GaiaDesk } from './client.js';
export type { GaiaDeskOptions, CallOptions, ExecOptions, StreamExecOptions, Forward } from './client.js';
export { CliStream } from './proc.js';
export type { Chunk, Exit, Completed } from './proc.js';
export { McpClient, McpError, MCP_PROTOCOL_VERSION, toolText, toolImage, toolNameAlias, resolveToolName } from './mcp.js';
export type { McpTool, McpToolResult, McpContent } from './mcp.js';
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
export type { ErrorKind, ErrorEnvelope } from './errors.js';
export type { RunShapeOptions, JobOptions, TokenCreateOptions, ForwardSpec, McpServerOptions } from './args.js';
export { locateCli } from './locate.js';
export * from './types.js';
