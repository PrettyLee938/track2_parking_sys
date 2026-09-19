// Authentication and user-management contracts.
// ---------------------------------------------------------------------------
// auth & users
// ---------------------------------------------------------------------------
/** admin can do everything an operator can, plus user management and site settings. */
export type Role = "admin" | "operator";

export interface UserView {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

/** POST /api/auth/login */
export interface LoginRequest { username: string; password: string }
/** POST /api/auth/login, GET /api/auth/me */
export interface MeResponse { user: UserView }
/** GET /api/users */
export interface UsersResponse { items: UserView[] }
/** POST /api/users */
export interface CreateUserRequest { username: string; password: string; role: Role }
/** PATCH /api/users/:id - any subset */
export interface UpdateUserRequest { role?: Role; disabled?: boolean; password?: string }

/** Error body for every 4xx. */
export interface ApiError { error: string }
