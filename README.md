# Lumen — Photo Gallery

A personal photo gallery with Google Drive–style folders, paired-photo view, and password-gated access.

## Features

- Upload single or paired photos
- Nested folder structure with breadcrumb navigation
- Pair view: display two photos side-by-side
- Password-protected access (token-based, in-memory)
- SQLite storage for metadata; original files stored on disk

## Stack

- Frontend: React + Vite + Tailwind + shadcn/ui + TanStack Query
- Backend: Express + better-sqlite3 + Drizzle ORM
- Auth: bearer token (issued on login, kept in memory)

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Configure the login password
cp .env.example .env
# then edit .env and set GALLERY_PASSWORD=<your choice>

# 3. Run in development
npm run dev

# 4. Build + run in production
npm run build
NODE_ENV=production node dist/index.cjs
```

The app listens on `http://localhost:5000` by default.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `GALLERY_PASSWORD` | yes | Password for the login screen. Login is disabled if unset. |
| `PORT` | no | Server port (default `5000`). |

## Notes

- `data.db` (SQLite) and the `uploads/` directory are gitignored — they hold your local photos and folder metadata.
- The auth token lives only in browser memory; you re-enter the password after a full page reload.
- `<img>` and download links use a `?t=<token>` query parameter because they cannot send an `Authorization` header.
