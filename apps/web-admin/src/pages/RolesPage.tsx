import { useState } from 'react'
import { requestJson } from '../lib/http'

// ======================================================
// RoleRow
//
// يمثل دورًا واحدًا داخل الشركة.
// كل Role يرجع ومعه قائمة أكواد الصلاحيات المرتبطة به.
// ======================================================
type RoleRow = {
  id: string
  company_id: string | null
  name: string
  code: string
  is_system: boolean
  created_at: string
  permissions: string[]
}

// ======================================================
// PermissionRow
//
// يمثل صلاحية واحدة متاحة داخل النظام.
// ======================================================
type PermissionRow = {
  id: string
  code: string
  description: string | null
}

type ApiResponse<T> = {
  data: T
}

function RolesPage() {
  const [roles, setRoles] = useState<RoleRow[]>([])
  const [permissions, setPermissions] = useState<PermissionRow[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ======================================================
  // loadAccessData
  //
  // يحمل الأدوار وكتالوج الصلاحيات بالتوازي.
  //
  // Backend يحدد الشركة من Session الموثقة،
  // لذلك لا نرسل companyId من المتصفح.
  // ======================================================
  async function loadAccessData() {
    setLoading(true)
    setError('')

    try {
      const [rolesResponse, permissionsResponse] = await Promise.all([
        requestJson<ApiResponse<RoleRow[]>>('/api/roles'),
        requestJson<ApiResponse<PermissionRow[]>>('/api/permissions'),
      ])

      setRoles(rolesResponse.data)
      setPermissions(permissionsResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'حدث خطأ غير معروف أثناء تحميل الأدوار والصلاحيات',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الأدوار والصلاحيات</h2>

            <p className="muted">
              عرض أدوار الشركة والصلاحيات المرتبطة بكل دور.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            disabled={loading}
            onClick={loadAccessData}
          >
            {loading ? 'جاري التحميل...' : 'تحميل الأدوار والصلاحيات'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
      </section>

      <section className="panel">
        <h2>الأدوار</h2>

        {roles.length === 0 ? (
          <p className="muted">لا توجد أدوار معروضة حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>اسم الدور</th>
                  <th>الكود</th>
                  <th>النوع</th>
                  <th>عدد الصلاحيات</th>
                  <th>الصلاحيات</th>
                </tr>
              </thead>

              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td>{role.name}</td>

                    <td>{role.code}</td>

                    <td>{role.is_system ? 'دور نظام' : 'دور مخصص'}</td>

                    <td>{role.permissions.length}</td>

                    <td>
                      {role.permissions.length > 0
                        ? role.permissions.join(', ')
                        : 'بدون صلاحيات'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>كتالوج الصلاحيات</h2>

        {permissions.length === 0 ? (
          <p className="muted">لا توجد صلاحيات معروضة حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>كود الصلاحية</th>
                  <th>الوصف</th>
                </tr>
              </thead>

              <tbody>
                {permissions.map((permission) => (
                  <tr key={permission.id}>
                    <td>{permission.code}</td>

                    <td>{permission.description || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

export default RolesPage
