import type { WebSocketConnectionStatus } from "$lib/websocket/types";

/** `idle` has not been attempted yet, `connecting`/`reconnecting` are in flight,
 *  and `unauthorized` is a policy outcome the user cannot act on — none of them
 *  are failures worth reporting. */
export function isErrorStatus(status: WebSocketConnectionStatus): boolean {
  return status === "disconnected" || status === "error";
}
