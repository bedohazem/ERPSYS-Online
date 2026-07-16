import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { hasPermission } from '../auth/permissions'
import { requestJson } from '../lib/http'

// ======================================================
// المستخدم كما يرجع من Backend API.
// ======================================================
type UserRow = {
  id: string
  company_id: string
  branch_id: string | null

  full_name: string
  username: string
  email: string | null

  is_active: boolean

  branch_code: string | null
  branch_name: string | null

  roles: string[]

  created_at: string
  updated_at: string
}

// ======================================================
// فرع متاح عند إنشاء المستخدم.
// ======================================================
type BranchOption = {
  id: string
  code: string
  name: string
}

// ======================================================
// دور متاح عند إنشاء المستخدم.
// ======================================================
type RoleOption = {
  id: string
  name: string
  code: string
  is_system: boolean
}

type UserCreationOptions = {
  branches: BranchOption[]
  roles: RoleOption[]
}

type ApiResponse<T> = {
  data: T
}

function UsersPage() {
  const { user } = useAuth()

  // الصفحة نفسها تحتاج users.manage.
  // الإنشاء يحتاج أيضًا roles.manage بسبب منح الأدوار.
  const canCreateUser = hasPermission(user, 'roles.manage')

  const [users, setUsers] = useState<UserRow[]>([])
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [roles, setRoles] = useState<RoleOption[]>([])

  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [branchId, setBranchId] = useState('')
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([])

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // ======================================================
  // رقم المستخدم الذي يتم تحديث حالته حاليًا.
  //
  // وجود القيمة يمنع الضغط المتكرر أثناء طلب الـ API.
  // ======================================================
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  // ======================================================
  // تحميل المستخدمين وبيانات الإنشاء.
  //
  // المستخدم الذي يملك users.manage فقط يستطيع العرض.
  // بيانات الأدوار لا تُطلب إلا عند امتلاك roles.manage.
  // ======================================================
  async function loadPageData() {
    setLoading(true)
    setError('')
    setSuccessMessage('')

    try {
      const usersRequest = requestJson<ApiResponse<UserRow[]>>('/api/users')

      if (canCreateUser) {
        const [usersResponse, optionsResponse] = await Promise.all([
          usersRequest,
          requestJson<ApiResponse<UserCreationOptions>>('/api/users/options'),
        ])

        setUsers(usersResponse.data)
        setBranches(optionsResponse.data.branches)
        setRoles(optionsResponse.data.roles)
      } else {
        const usersResponse = await usersRequest

        setUsers(usersResponse.data)
        setBranches([])
        setRoles([])
      }
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'حدث خطأ أثناء تحميل بيانات المستخدمين',
      )
    } finally {
      setLoading(false)
    }
  }

  // ======================================================
  // تحديد أو إلغاء دور من المستخدم الجديد.
  // ======================================================
  function toggleRole(roleId: string) {
    setSelectedRoleIds((currentRoleIds) =>
      currentRoleIds.includes(roleId)
        ? currentRoleIds.filter((currentRoleId) => currentRoleId !== roleId)
        : [...currentRoleIds, roleId],
    )
  }

  // ======================================================
  // إنشاء مستخدم جديد.
  //
  // الشركة لا يتم إرسالها.
  // Backend يأخذها من Session الموثقة.
  // ======================================================
  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    setError('')
    setSuccessMessage('')

    if (!fullName.trim()) {
      setError('الاسم الكامل مطلوب')
      return
    }

    if (!username.trim()) {
      setError('اسم المستخدم مطلوب')
      return
    }

    if (password.length < 8) {
      setError('كلمة المرور يجب ألا تقل عن 8 حروف')
      return
    }

    if (selectedRoleIds.length === 0) {
      setError('يجب اختيار دور واحد على الأقل')
      return
    }

    setSaving(true)

    try {
      const response = await requestJson<ApiResponse<UserRow>>('/api/users', {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
        },

        body: JSON.stringify({
          fullName: fullName.trim(),
          username: username.trim(),
          email: email.trim() || null,
          password,
          branchId: branchId || null,
          roleIds: selectedRoleIds,
        }),
      })

      // إضافة المستخدم الجديد مباشرة داخل الجدول.
      setUsers((currentUsers) =>
        [...currentUsers, response.data].sort((firstUser, secondUser) =>
          firstUser.full_name.localeCompare(secondUser.full_name, 'ar'),
        ),
      )

      // تنظيف الفورم بعد الحفظ الناجح.
      setFullName('')
      setUsername('')
      setEmail('')
      setPassword('')
      setBranchId('')
      setSelectedRoleIds([])

      setSuccessMessage(`تم إنشاء المستخدم ${response.data.full_name} بنجاح`)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'حدث خطأ أثناء إنشاء المستخدم',
      )
    } finally {
      setSaving(false)
    }
  }

  // ======================================================
  // updateUserStatus
  //
  // تفعيل أو تعطيل مستخدم موجود.
  //
  // Backend مسؤول عن الحماية النهائية، ومنها:
  // - منع تعطيل الحساب الحالي.
  // - منع تعطيل آخر Admin نشط.
  // - منع تعديل مستخدم تابع لشركة أخرى.
  // ======================================================
  async function updateUserStatus(targetUser: UserRow) {
    const nextIsActive = !targetUser.is_active

    // نطلب تأكيدًا فقط عند التعطيل لأنه الإجراء الأخطر.
    if (
      !nextIsActive &&
      !window.confirm(`هل أنت متأكد من تعطيل المستخدم ${targetUser.full_name}؟`)
    ) {
      return
    }

    setUpdatingUserId(targetUser.id)
    setError('')
    setSuccessMessage('')

    try {
      const response = await requestJson<ApiResponse<UserRow>>(
        `/api/users/${encodeURIComponent(targetUser.id)}/status`,
        {
          method: 'PATCH',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            isActive: nextIsActive,
          }),
        },
      )

      // استبدال المستخدم المعدل داخل الجدول بدون إعادة تحميل الصفحة.
      setUsers((currentUsers) =>
        currentUsers.map((currentUser) =>
          currentUser.id === response.data.id ? response.data : currentUser,
        ),
      )

      setSuccessMessage(
        nextIsActive
          ? `تم تفعيل المستخدم ${response.data.full_name}`
          : `تم تعطيل المستخدم ${response.data.full_name}`,
      )
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'حدث خطأ أثناء تحديث حالة المستخدم',
      )
    } finally {
      setUpdatingUserId(null)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>إدارة المستخدمين</h2>

            <p className="muted">
              عرض مستخدمي الشركة وإنشاء مستخدمين جدد بأدوار وفروع محددة.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            // منع إعادة التحميل أثناء أي عملية حفظ أو تحديث حالة.
            disabled={loading || saving || Boolean(updatingUserId)}
            onClick={loadPageData}
          >
            {loading ? 'جاري التحميل...' : 'تحميل بيانات المستخدمين'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {successMessage ? (
          <p className="success-message">{successMessage}</p>
        ) : null}
      </section>

      {canCreateUser ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>مستخدم جديد</h2>

              <p className="muted">
                حمّل بيانات المستخدمين أولًا حتى تظهر الفروع والأدوار.
              </p>
            </div>
          </div>

          <form onSubmit={createUser}>
            <div className="form-grid">
              <label>
                الاسم الكامل
                <input
                  value={fullName}
                  maxLength={150}
                  disabled={saving}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="مثال: أحمد محمد"
                />
              </label>

              <label>
                اسم المستخدم
                <input
                  value={username}
                  maxLength={50}
                  disabled={saving}
                  onChange={(event) =>
                    setUsername(event.target.value.toLowerCase())
                  }
                  placeholder="مثال: ahmed"
                />
              </label>

              <label>
                البريد الإلكتروني
                <input
                  type="email"
                  value={email}
                  disabled={saving}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="اختياري"
                />
              </label>

              <label>
                كلمة المرور
                <input
                  type="password"
                  value={password}
                  minLength={8}
                  maxLength={128}
                  disabled={saving}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="8 حروف على الأقل"
                />
              </label>

              <label>
                الفرع
                <select
                  value={branchId}
                  disabled={saving}
                  onChange={(event) => setBranchId(event.target.value)}
                >
                  <option value="">كل الفروع / مستوى الشركة</option>

                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name} ({branch.code})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="section-header">
              <div>
                <h3>الأدوار</h3>

                <p className="muted">اختر دورًا واحدًا على الأقل.</p>
              </div>
            </div>

            <div className="form-grid">
              {roles.map((role) => (
                <label key={role.id}>
                  <input
                    type="checkbox"
                    checked={selectedRoleIds.includes(role.id)}
                    disabled={saving}
                    onChange={() => toggleRole(role.id)}
                  />
                  {role.name} ({role.code})
                </label>
              ))}
            </div>

            <button
              type="submit"
              className="primary-button"
              disabled={
                saving || roles.length === 0 || selectedRoleIds.length === 0
              }
            >
              {saving ? 'جاري إنشاء المستخدم...' : 'إنشاء المستخدم'}
            </button>
          </form>
        </section>
      ) : (
        <section className="panel">
          <p className="muted">
            لديك صلاحية عرض المستخدمين، لكن إنشاء مستخدم ومنح الأدوار يحتاج
            صلاحية roles.manage.
          </p>
        </section>
      )}

      <section className="panel">
        <h2>المستخدمون</h2>

        {users.length === 0 ? (
          <p className="muted">لا توجد بيانات مستخدمين معروضة حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>اسم المستخدم</th>
                  <th>البريد الإلكتروني</th>
                  <th>الفرع</th>
                  <th>كود الفرع</th>
                  <th>الأدوار</th>
                  <th>الحالة</th>
                  <th>الإجراء</th>
                </tr>
              </thead>

              <tbody>
                {users.map((currentUser) => (
                  <tr key={currentUser.id}>
                    <td>{currentUser.full_name}</td>
                    <td>{currentUser.username}</td>
                    <td>{currentUser.email || '-'}</td>
                    <td>{currentUser.branch_name || 'كل الفروع'}</td>
                    <td>{currentUser.branch_code || '-'}</td>

                    <td>
                      {currentUser.roles.length > 0
                        ? currentUser.roles.join(', ')
                        : 'بدون دور'}
                    </td>

                    <td>{currentUser.is_active ? 'نشط' : 'غير نشط'}</td>
                    <td>
                      {currentUser.id === user?.userId ? (
                        // لا نظهر زر تعطيل أمام الحساب المسجل حاليًا.
                        <span className="muted">الحساب الحالي</span>
                      ) : (
                        <button
                          type="button"
                          className={
                            currentUser.is_active
                              ? 'table-button danger-button'
                              : 'table-button'
                          }
                          disabled={Boolean(updatingUserId)}
                          onClick={() => {
                            void updateUserStatus(currentUser)
                          }}
                        >
                          {updatingUserId === currentUser.id
                            ? 'جاري التحديث...'
                            : currentUser.is_active
                              ? 'تعطيل'
                              : 'تفعيل'}
                        </button>
                      )}
                    </td>
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

export default UsersPage
