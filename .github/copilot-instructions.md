# Copilot Instructions for AI Agents

## Project Overview
- **designer** is a Node.js/Express backend for managing projects and users, using PostgreSQL for data storage.
- The codebase is structured by feature: routes (API endpoints), middleware (auth), and db (PostgreSQL connection/migrations).
- Main entry: `server.js` (loads env, sets up Express, mounts routers, connects to DB).

## Key Components
- **Database**: PostgreSQL, connection via `db.js` (`pool`). Migrations in `db/migrations/` (see `.sql` files for schema triggers/functions).
- **Routes**: All API endpoints are in `routes/`:
  - `user.js`: Health check endpoint.
  - `auth.js`: Registration, login, JWT/cookie auth, user management.
  - `ops.js`: Admin bootstrap endpoint (`/init-admin`), requires `INIT_SECRET`.
  - `me.js`: User info lookup by username.
  - `projects.js`: Project CRUD, requires authentication.
  - `responsibleuser.js`: Responsible user dropdown/options, with role-based filtering.
- **Middleware**: `middleware/auth.js` handles JWT extraction, user injection, and role checks (`attachUser`, `requireAuth`, `requireAdmin`).

## Auth & Security
- JWT tokens are stored in cookies (`auth` or `token`) or `Authorization` header. See `middleware/auth.js` for extraction logic.
- Role-based access: `admin` vs `member` enforced in route handlers.
- Initial admin setup: POST `/__ops/init-admin` with `X-Init-Secret` header matching `process.env.INIT_SECRET`.

## Developer Workflows
- **Start server (dev)**: `npm run dev` (uses `NODE_ENV=development`)
- **Start server (prod)**: `npm start` (uses `NODE_ENV=production`)
- **DB migration**: Run scripts in `package.json` (e.g., `npm run db:migrate:up:001`)
- **No built-in tests**: Add tests as needed; current `npm test` is a placeholder.

## Project Conventions
- All DB access via `pool` from `db.js`.
- Use async/await for all DB and route logic.
- API responses are always JSON with `{ ok: true/false, ... }`.
- Health checks: `/api/users/health`, `/api/responsible-user/ping`.
- Use `attachUser` middleware before `requireAuth` for protected routes.
- Use `dayjs` for date handling.
- Error handling: log errors, return `{ ok: false, message }`.

## Integration & Patterns
- External dependencies: `express`, `pg`, `jsonwebtoken`, `bcrypt`, `dayjs`, `dotenv`, `helmet`, `morgan`, `cors`.
- Environment variables: `.env` file for DB connection, JWT secret, and admin init secret.
- Project structure is flat, feature-based, and easy to extend with new routes/middleware.

## Examples
- To add a new protected API:
  1. Create a new file in `routes/`, export an Express router.
  2. Use `attachUser` and `requireAuth` as middleware.
  3. Mount the router in `server.js`.

- To add a DB migration:
  1. Add a `.sql` file in `db/migrations/`.
  2. Add a script in `package.json` to run it.

---

For more details, see `server.js`, `db.js`, and the `routes/` directory. Ask for clarification if any workflow or pattern is unclear.
