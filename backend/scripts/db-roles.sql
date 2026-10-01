-- Least-privilege database role for the application (spec section 9).
-- Run once as a superuser AFTER migrations; migrations themselves run with the owner role.
--   psql -v app_password="'change-me'" -f scripts/db-roles.sql
CREATE ROLE shiftsched_app LOGIN PASSWORD :app_password;
GRANT USAGE ON SCHEMA public TO shiftsched_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shiftsched_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shiftsched_app;
-- audit_logs is append-only for the app (the trigger also blocks UPDATE/DELETE)
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM shiftsched_app;
-- no DDL: the app role owns nothing and has no CREATE on the schema
REVOKE CREATE ON SCHEMA public FROM shiftsched_app;
