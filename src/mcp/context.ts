import type { MCPServer, RequestContext } from "mcp-use";
import type { AgentPrincipal } from "../auth/service.ts";
export type BoardEnv = { Variables: { principal: AgentPrincipal } };
export type BoardContext = RequestContext<never, false, BoardEnv>;
export type BoardMcp = MCPServer<never, BoardEnv>;
