// Manual-control contracts.
// ---------------------------------------------------------------------------
// manual control
// ---------------------------------------------------------------------------
/** POST /api/control/gates/:name/:action */
export type GateAction = "open" | "close" | "auto" | "repair";

/** Result of any control command. */
export interface ControlResult { ok: boolean; message: string }

/** GET /api/actions - commands sent to the simulator; actor null = the controller. */
export interface ActionView {
  id: number;
  at: string;
  cmd: string;
  args: string[];
  ok: boolean;
  error: string | null;
  ms: number;
  actor: string | null;
}
export interface ActionsResponse { items: ActionView[] }
