import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
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
  // التحكم في ظهور نموذج إنشاء دور جديد.
  const [showCreateForm, setShowCreateForm] = useState(false)
  // ======================================================
  // بيانات إنشاء دور مخصص جديد.
  // ======================================================
  const [roleName, setRoleName] = useState('')
  const [roleCode, setRoleCode] = useState('')
  const [selectedPermissionIds, setSelectedPermissionIds] = useState<string[]>(
    [],
  )

  const [saving, setSaving] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')

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
    setSuccessMessage('')

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

  // ======================================================
  // تحميل بيانات الصفحة تلقائيًا عند فتحها.
  //
  // زر التحميل الموجود بالأعلى سيستخدم بعد ذلك
  // كتحديث يدوي فقط عند الحاجة.
  // ======================================================
  useEffect(() => {
    void loadAccessData()
  }, [])

  // ======================================================
  // togglePermission
  //
  // تحديد أو إلغاء صلاحية من الدور الجديد.
  // ======================================================
  function togglePermission(permissionId: string) {
    setSelectedPermissionIds((currentPermissionIds) =>
      currentPermissionIds.includes(permissionId)
        ? currentPermissionIds.filter(
            (currentPermissionId) => currentPermissionId !== permissionId,
          )
        : [...currentPermissionIds, permissionId],
    )
  }

  // ======================================================
  // createRole
  //
  // إنشاء دور مخصص داخل الشركة الحالية.
  // Backend يأخذ companyId من Session الموثقة.
  // ======================================================
  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    setError('')
    setSuccessMessage('')

    if (!roleName.trim()) {
      setError('اسم الدور مطلوب')
      return
    }

    const normalizedCode = roleCode.trim().toLowerCase()

    if (!/^[a-z][a-z0-9._-]{2,49}$/.test(normalizedCode)) {
      setError('كود الدور يبدأ بحرف إنجليزي ويحتوي على 3 إلى 50 حرفًا')
      return
    }

    if (normalizedCode === 'admin') {
      setError('لا يمكن استخدام كود admin')
      return
    }

    if (selectedPermissionIds.length === 0) {
      setError('يجب اختيار صلاحية واحدة على الأقل')
      return
    }

    setSaving(true)

    try {
      const response = await requestJson<ApiResponse<RoleRow>>('/api/roles', {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
        },

        body: JSON.stringify({
          name: roleName.trim(),
          code: normalizedCode,
          permissionIds: selectedPermissionIds,
        }),
      })

      // إضافة الدور الجديد مباشرة داخل الجدول.
      setRoles((currentRoles) =>
        [...currentRoles, response.data].sort((firstRole, secondRole) =>
          firstRole.name.localeCompare(secondRole.name, 'ar'),
        ),
      )

      setRoleName('')
      setRoleCode('')
      setSelectedPermissionIds([])
      // إغلاق النموذج بعد الإنشاء الناجح.
      setShowCreateForm(false)
      setSuccessMessage(`تم إنشاء الدور ${response.data.name} بنجاح`)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'حدث خطأ أثناء إنشاء الدور',
      )
    } finally {
      setSaving(false)
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

          <div className="section-actions">
            <button
              type="button"
              className="primary-button small-button"
              disabled={saving}
              onClick={() => {
                setError('')
                setSuccessMessage('')
                setShowCreateForm((currentValue) => !currentValue)
              }}
            >
              {showCreateForm ? 'إغلاق النموذج' : 'دور جديد'}
            </button>

            <button
              type="button"
              className="table-button"
              disabled={loading || saving}
              onClick={loadAccessData}
            >
              {loading ? 'جاري التحديث...' : 'تحديث'}
            </button>
          </div>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
        {successMessage ? (
          <p className="success-message">{successMessage}</p>
        ) : null}
      </section>

      {showCreateForm ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>دور مخصص جديد</h2>

              <p className="muted">
                أنشئ دورًا مخصصًا وحدد الصلاحيات المناسبة له.
              </p>
            </div>
          </div>

          <form onSubmit={createRole}>
            <div className="form-grid">
              <label>
                اسم الدور
                <input
                  value={roleName}
                  maxLength={100}
                  disabled={saving}
                  onChange={(event) => setRoleName(event.target.value)}
                  placeholder="مثال: مدير المخزن"
                />
              </label>

              <label>
                كود الدور
                <input
                  value={roleCode}
                  maxLength={50}
                  disabled={saving}
                  onChange={(event) =>
                    setRoleCode(
                      event.target.value.toLowerCase().replace(/\s+/g, '_'),
                    )
                  }
                  placeholder="مثال: warehouse_manager"
                />
              </label>
            </div>

            <div className="section-header">
              <div>
                <h3>صلاحيات الدور</h3>

                <p className="muted">اختر صلاحية واحدة على الأقل.</p>
              </div>
            </div>

            {permissions.length === 0 ? (
              <p className="muted">
                {loading
                  ? 'جاري تحميل كتالوج الصلاحيات...'
                  : 'لا توجد صلاحيات متاحة حاليًا.'}
              </p>
            ) : (
              <div className="form-grid">
                {permissions.map((permission) => (
                  <label key={permission.id}>
                    <input
                      type="checkbox"
                      checked={selectedPermissionIds.includes(permission.id)}
                      disabled={saving}
                      onChange={() => togglePermission(permission.id)}
                    />

                    {permission.code}
                    {permission.description
                      ? ` — ${permission.description}`
                      : ''}
                  </label>
                ))}
              </div>
            )}

            <button
              type="submit"
              className="primary-button"
              disabled={
                saving ||
                permissions.length === 0 ||
                selectedPermissionIds.length === 0
              }
            >
              {saving ? 'جاري إنشاء الدور...' : 'إنشاء الدور'}
            </button>
          </form>
        </section>
      ) : null}

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
