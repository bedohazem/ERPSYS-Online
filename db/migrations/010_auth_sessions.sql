-- ============================================================
-- Migration 010: Authentication Sessions
--
-- الهدف:
-- 1. إضافة كود واضح لكل شركة لاستخدامه في تسجيل الدخول.
-- 2. إنشاء جلسات مستخدمين قابلة للإلغاء.
-- 3. تخزين Hash للتوكن فقط وعدم تخزين التوكن الأصلي.
-- 4. ربط كل جلسة بالمستخدم والشركة داخل PostgreSQL.
-- ============================================================


-- ============================================================
-- 1. Company Code
--
-- المستخدم سيسجل الدخول باستخدام:
-- companyCode + username + password
--
-- بدل كتابة companyId كـ UUID يدويًا.
-- ============================================================

ALTER TABLE companies
ADD COLUMN code TEXT;

-- نعطي الشركة التجريبية كود DEMO.
UPDATE companies
SET code = 'DEMO'
WHERE name = 'Demo Fashion Brand'
  AND code IS NULL;

-- أي شركة أخرى موجودة تحصل على كود مؤقت فريد.
UPDATE companies
SET code =
    'COMPANY-' ||
    UPPER(
        SUBSTRING(
            REPLACE(id::text, '-', '')
            FROM 1 FOR 8
        )
    )
WHERE code IS NULL;

ALTER TABLE companies
ALTER COLUMN code SET NOT NULL;

ALTER TABLE companies
ADD CONSTRAINT ck_companies_code_format
CHECK (
    code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$'
);

-- الكود لا يتكرر حتى لو اختلفت حالة الحروف.
CREATE UNIQUE INDEX uq_companies_code_ci
ON companies (LOWER(code));


-- ============================================================
-- 2. Authentication Sessions
--
-- token_hash:
-- نخزن SHA-256 للتوكن فقط.
-- التوكن الحقيقي يرجع للمستخدم مرة واحدة عند Login.
--
-- revoked_at:
-- عند Logout أو إيقاف الجلسة نسجل وقت الإلغاء.
-- ============================================================

CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    company_id UUID NOT NULL,
    user_id UUID NOT NULL,

    token_hash TEXT NOT NULL,

    session_name TEXT,

    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,

    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    ip_address TEXT,
    user_agent TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_auth_sessions_token_hash
        UNIQUE (token_hash),

    CONSTRAINT fk_auth_sessions_tenant_user
        FOREIGN KEY (company_id, user_id)
        REFERENCES users (company_id, id)
        ON DELETE CASCADE,

    CONSTRAINT ck_auth_sessions_expiry
        CHECK (expires_at > created_at)
);


-- ============================================================
-- 3. Session Indexes
--
-- تساعد في:
-- - البحث عن جلسات المستخدم.
-- - تنظيف الجلسات المنتهية.
-- - مراجعة الجلسات النشطة.
-- ============================================================

CREATE INDEX idx_auth_sessions_user
ON auth_sessions (company_id, user_id);

CREATE INDEX idx_auth_sessions_active_user
ON auth_sessions (company_id, user_id, expires_at)
WHERE revoked_at IS NULL;

CREATE INDEX idx_auth_sessions_expires_at
ON auth_sessions (expires_at)
WHERE revoked_at IS NULL;