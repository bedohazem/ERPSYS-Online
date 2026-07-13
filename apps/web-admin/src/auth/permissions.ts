import type { AuthUser } from './AuthContext'

export function hasPermission(
  user: AuthUser | null | undefined,
  permission: string,
) {
  return (
    user?.roles.includes('admin') ||
    user?.permissions.includes(permission) ||
    false
  )
}
